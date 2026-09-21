import { randomUUID } from 'node:crypto';
import type { CaptureOutcome, CaptureProvider, CaptureRequest, TargetPolicy } from '@oe/capture';
import {
  advanceScan,
  findOpportunityByAccountAndRootCause,
  getAccount,
  getScan,
  getUsableAuthorization,
  insertAuditEvent,
  insertEvidence,
  insertFinding,
  insertOpportunity,
  linkFindingEvidence,
  linkOpportunityFinding,
  listEvidenceForScan,
  markReservationUncertain,
  releaseReservation,
  settleReservation,
  upsertScanStep,
  type Database,
  type QueryExecutor,
  type ScanRow,
} from '@oe/db';
import type { EvidenceStore } from '@oe/evidence';
import {
  aggregateNeed,
  classifyLink,
  DETECTOR_ID,
  DETECTOR_VERSION,
  evaluateImportantLink,
  scoreOpportunity,
  type LinkObservation,
} from '@oe/domain';

/**
 * The MF-LINK-01 scan workflow.
 *
 * Durable in the sense that matters here: every step is a compare-and-swap on the scan row
 * plus an append to `oe.scan_steps`, so a restart resumes from the database rather than
 * from memory, and a repeated delivery of the same outbox event cannot double any effect.
 *
 * WORKFLOWS.md: "`succeeded` means the scheduled capture/detector work finished with
 * sufficient coverage for its checks, not that a reviewed finding exists."
 */

export interface RunnerOptions {
  db: Database;
  capture: CaptureProvider;
  /** Must be the same policy the API admitted the scan under. */
  targetPolicy: TargetPolicy;
  evidence: EvidenceStore;
  now: () => Date;
  newId?: () => string;
  /** Artifact retention default from SECURITY.md, owner-approved rather than statutory. */
  artifactTtlDays?: number;
  /** Content is revalidated before publication after this many days. */
  freshnessDays?: number;
  log?: (event: Record<string, unknown>) => void;
}

const VIEWPORT = { width: 1280, height: 900 };
const LOCALE = 'de-DE';
const LIMITS = { timeoutMs: 10_000, maxBytes: 2_000_000, maxHops: 3 };

export class ScanRunner {
  readonly #options: Required<Omit<RunnerOptions, 'log'>> & { log: (event: Record<string, unknown>) => void };

  constructor(options: RunnerOptions) {
    this.#options = {
      db: options.db,
      capture: options.capture,
      targetPolicy: options.targetPolicy,
      evidence: options.evidence,
      now: options.now,
      newId: options.newId ?? (() => randomUUID()),
      artifactTtlDays: options.artifactTtlDays ?? 30,
      freshnessDays: options.freshnessDays ?? 7,
      log: options.log ?? (() => undefined),
    };
  }

  /**
   * Execute one scan to a terminal state.
   *
   * Safe to call twice for the same scan: a scan that is already terminal returns
   * immediately, and each phase re-reads the row before advancing it.
   */
  async run(tenantId: string, scanId: string): Promise<{ state: string; reasons: string[] }> {
    const { db, now } = this.#options;

    const start = await db.withTenant(tenantId, async (tx) => {
      const scan = await getScan(tx, scanId);
      if (!scan) return null;
      if (TERMINAL.has(scan.state)) return { scan, alreadyDone: true };
      if (scan.state === 'cancel_requested') return { scan, alreadyDone: false };
      if (scan.state !== 'queued') return { scan, alreadyDone: false };
      const advanced = await advanceScan(tx, {
        id: scanId,
        expectedVersion: scan.version,
        nextState: 'validating',
      });
      return advanced ? { scan: advanced, alreadyDone: false } : { scan, alreadyDone: false };
    });
    if (!start) return { state: 'unknown', reasons: ['Scan not visible in this tenant.'] };
    if (start.alreadyDone) {
      return { state: start.scan.state, reasons: (start.scan.reasons ?? []).map(String) };
    }

    // 1 · Re-check permission at execution time. ROLES_PERMISSIONS.md: "Revocation
    // immediately stops new reads/jobs; in-flight workers recheck before new operations."
    const permission = await db.withTenant(tenantId, async (tx) => {
      const scan = await getScan(tx, scanId);
      if (!scan) return { ok: false as const, reason: 'Scan disappeared.' };
      const account = await getAccount(tx, scan.account_id);
      if (!account) return { ok: false as const, reason: 'Account is no longer available.' };
      const authorization = await getUsableAuthorization(tx, {
        id: scan.authorization_id,
        accountId: scan.account_id,
        action: 'scan_public',
        now: now().toISOString(),
      });
      if (authorization.reason !== 'ok') {
        return { ok: false as const, reason: `Scan authorization is ${authorization.reason}. No capture was attempted.` };
      }
      const preflight = this.#options.targetPolicy(scan.target_url, account.approved_hosts);
      if (!preflight.allowed) {
        return { ok: false as const, reason: `Target rejected by the capture policy (${preflight.reason}).` };
      }
      return { ok: true as const, scan, account, url: preflight.url };
    });

    if (!permission.ok) {
      return this.#terminate(tenantId, scanId, 'blocked', [permission.reason]);
    }
    if (!this.#options.capture.configured) {
      // COPY.md: "Live capture is not configured. No scan has been performed."
      return this.#terminate(tenantId, scanId, 'blocked', [
        'Live capture is not configured. No scan has been performed.',
      ]);
    }

    await this.#step(tenantId, scanId, 'validate', 'succeeded');
    if (await this.#cancelled(tenantId, scanId)) return this.#cancel(tenantId, scanId);

    await this.#advance(tenantId, scanId, 'capturing');

    const reasons: string[] = [];
    const account = permission.account;
    const sourceUrl = permission.url;

    // 2 · Two clean sessions of the source page.
    const sourceCaptures = await this.#captureTwice({
      tenantId,
      scanId,
      url: sourceUrl,
      approvedHosts: account.approved_hosts,
      role: 'source_page',
      accountId: account.id,
      stepPrefix: 'capture:source',
    });
    if (sourceCaptures.fatal) {
      return this.#terminate(tenantId, scanId, 'blocked', [sourceCaptures.fatal]);
    }
    reasons.push(...sourceCaptures.reasons);
    if (await this.#cancelled(tenantId, scanId)) return this.#cancel(tenantId, scanId);

    // 3 · Choose at most one informational link from the first complete source capture.
    //     Page text is evidence, never instruction: the candidate still has to pass
    //     `classifyLink` and the account's approved-host policy.
    const firstSource = sourceCaptures.captured[0];
    const links = firstSource?.observation.links ?? [];
    const candidate = links.find((link) => {
      if (classifyLink(link.text, link.href).kind !== 'important_information') return false;
      return this.#options.targetPolicy(link.href, account.approved_hosts).allowed;
    });

    let capturedPages = sourceCaptures.captured.length > 0 ? 1 : 0;
    let destinationObservations: LinkObservation[] = [];
    let destinationUrl: string | null = null;

    if (!candidate) {
      reasons.push(
        links.length === 0
          ? 'No informational link was found on the inspected page.'
          : 'No linked information page passed the navigation policy, so none was opened.',
      );
    } else {
      const destinationCheck = this.#options.targetPolicy(candidate.href, account.approved_hosts);
      destinationUrl = destinationCheck.allowed ? destinationCheck.url : null;
      if (destinationUrl) {
        const destination = await this.#captureTwice({
          tenantId,
          scanId,
          url: destinationUrl,
          approvedHosts: account.approved_hosts,
          role: 'link_destination',
          accountId: account.id,
          stepPrefix: 'capture:destination',
        });
        reasons.push(...destination.reasons);
        if (destination.captured.length > 0) capturedPages += 1;
        destinationObservations = destination.observations;
      }
    }

    if (await this.#cancelled(tenantId, scanId)) return this.#cancel(tenantId, scanId);
    await this.#advance(tenantId, scanId, 'analysing', capturedPages, reasons);

    // 4 · Deterministic detection. Two independent, comparable, complete observations or
    //     the rule abstains — it never guesses from one capture.
    const verdict = evaluateImportantLink({
      linkKind: candidate ? 'important_information' : 'unsupported',
      navigationApproved: Boolean(destinationUrl),
      target: destinationUrl ?? '',
      observations: destinationObservations,
      now: now().toISOString(),
      maxAgeMs: this.#options.freshnessDays * 86_400_000,
    });

    await this.#step(tenantId, scanId, 'detect:MF-LINK-01', 'succeeded');

    if (verdict.result === 'candidate' || verdict.result === 'unknown') {
      if (destinationUrl && destinationObservations.length > 0) {
        await this.#recordFinding(tenantId, scanId, {
          accountId: account.id,
          targetUrl: destinationUrl,
          verdict,
          sourceUrl,
        });
      } else if (verdict.result === 'unknown') {
        reasons.push(`The link check could not be completed: ${verdict.reason.replaceAll('_', ' ')}.`);
      }
    } else {
      reasons.push('The linked information page loaded in both recorded checks.');
    }

    // 5 · Settle the reservation with the cost actually incurred.
    await this.#settle(tenantId, scanId, sourceCaptures.costMicro);

    const complete = capturedPages > 0 && destinationObservations.length >= 2;
    const finalState = complete ? 'succeeded' : 'partial';
    if (!complete) {
      reasons.push(
        `${capturedPages} of ${permission.scan.expected_unique_pages} pages were captured. The remaining pages could not be inspected.`,
      );
    }
    return this.#terminate(tenantId, scanId, finalState, reasons, capturedPages);
  }

  /* ------------------------------------------------------------ steps */

  async #captureTwice(input: {
    tenantId: string;
    scanId: string;
    url: string;
    approvedHosts: string[];
    accountId: string;
    role: 'source_page' | 'link_destination';
    stepPrefix: string;
  }): Promise<{
    captured: { observation: NonNullable<Extract<CaptureOutcome, { status: 'captured' }>['observation']> }[];
    observations: LinkObservation[];
    reasons: string[];
    costMicro: string;
    fatal?: string;
  }> {
    const captured: { observation: NonNullable<Extract<CaptureOutcome, { status: 'captured' }>['observation']> }[] = [];
    const observations: LinkObservation[] = [];
    const reasons: string[] = [];
    let costMicro = 0n;

    for (const ordinal of [1, 2] as const) {
      const sessionId = `${input.scanId}:${input.role}:${ordinal}`;
      const request: CaptureRequest = {
        url: input.url,
        approvedHosts: input.approvedHosts,
        sessionId,
        sessionOrdinal: ordinal,
        contextKey: 'pending',
        role: input.role,
        viewport: VIEWPORT,
        locale: LOCALE,
        operationKey: `scan:${input.scanId}:capture`,
        limits: LIMITS,
      };
      const stepKey = `${input.stepPrefix}:${ordinal}`;
      const outcome = await this.#options.capture.capture(request);

      if (outcome.status !== 'captured') {
        await this.#step(input.tenantId, input.scanId, stepKey, outcome.status === 'retryable_error' ? 'failed' : 'blocked');
        const detail = `${input.role === 'source_page' ? 'The inspected page' : 'The linked information page'} could not be captured: ${outcome.detail}`;
        if (input.role === 'source_page' && ordinal === 1) return { captured, observations, reasons, costMicro: '0', fatal: detail };
        reasons.push(detail);
        continue;
      }

      costMicro += BigInt(outcome.costMicro);
      // The context key ties the two observations to the same page state. Different
      // variants are not comparable and the detector must abstain.
      const contextKey = `${new URL(outcome.observation.finalUrl).pathname}|${outcome.conditions.variant ?? 'no-variant'}|${VIEWPORT.width}x${VIEWPORT.height}|${LOCALE}`;

      const evidenceId = await this.#persistEvidence({
        tenantId: input.tenantId,
        scanId: input.scanId,
        accountId: input.accountId,
        sourceUrl: input.url,
        role: input.role,
        ordinal,
        contextKey,
        outcome,
      });

      captured.push({ observation: outcome.observation });
      observations.push({
        sessionId,
        evidenceId,
        capturedAt: outcome.conditions.captured_at,
        target: input.url,
        contextKey,
        status: outcome.observation.status,
        complete: outcome.observation.complete,
        challenge: outcome.observation.challenge,
        loginWall: outcome.observation.loginWall,
        soft404: outcome.observation.soft404,
      });

      if (outcome.observation.challenge) {
        reasons.push(
          `An access check answered instead of ${input.role === 'source_page' ? 'the inspected page' : 'the linked information page'}, so the check was not completed.`,
        );
      }
      if (outcome.observation.soft404) {
        reasons.push(
          `${input.role === 'source_page' ? 'The inspected page' : 'The linked information page'} answered 200 but presents itself as "not found"; the result is ambiguous.`,
        );
      }
      await this.#step(input.tenantId, input.scanId, stepKey, 'succeeded', outcome.providerRequestId);
    }

    return { captured, observations, reasons, costMicro: costMicro.toString() };
  }

  async #persistEvidence(input: {
    tenantId: string;
    scanId: string;
    accountId: string;
    sourceUrl: string;
    role: 'source_page' | 'link_destination';
    ordinal: number;
    contextKey: string;
    outcome: Extract<CaptureOutcome, { status: 'captured' }>;
  }): Promise<string> {
    const { db, evidence: store, now, artifactTtlDays } = this.#options;
    const expiresAt = new Date(now().getTime() + artifactTtlDays * 86_400_000).toISOString();
    const observation = input.outcome.observation;

    let objectKey: string | null = null;
    let sha256: string;
    if (observation.screenshot && store.available) {
      const stored = await store.put({
        tenantId: input.tenantId,
        scanId: input.scanId,
        name: `${input.role}-${input.ordinal}.png`,
        contentType: observation.screenshot.contentType,
        body: observation.screenshot.body,
      });
      objectKey = stored.objectKey;
      sha256 = stored.sha256;
    } else {
      // No artifact: hash the recorded response so the observation is still verifiable.
      const { createHash } = await import('node:crypto');
      sha256 = createHash('sha256')
        .update(observation.body ?? new Uint8Array())
        .digest('hex');
    }

    return db.withTenant(input.tenantId, async (tx) => {
      const assetId = await this.#ensureAssetFor(tx, input.accountId, input.sourceUrl);
      const row = await insertEvidence(tx, {
        id: this.#options.newId(),
        scanId: input.scanId,
        assetId,
        kind: observation.screenshot ? 'screenshot' : 'http_observation',
        sourceUrl: input.sourceUrl,
        finalUrl: observation.finalUrl,
        objectKey,
        sha256,
        conditions: input.outcome.conditions as unknown as Record<string, unknown>,
        observation: {
          status: observation.status,
          redirect_chain: observation.redirectChain,
          challenge: observation.challenge,
          login_wall: observation.loginWall,
          soft_404: observation.soft404,
          body_bytes: observation.bodyBytes,
          content_type: observation.contentType,
          screenshot_unavailable_reason: observation.screenshotUnavailableReason,
          provider_request_id: input.outcome.providerRequestId,
        },
        httpStatus: observation.status,
        complete: observation.complete,
        captureRole: input.role,
        sessionOrdinal: input.ordinal,
        contextKey: input.contextKey,
        capturedAt: input.outcome.conditions.captured_at,
        expiresAt,
      });
      return row.id;
    });
  }

  async #ensureAssetFor(tx: QueryExecutor, accountId: string, url: string): Promise<string> {
    const { ensureAsset } = await import('@oe/db');
    return ensureAsset(tx, { id: this.#options.newId(), accountId, canonicalUrl: url });
  }

  async #recordFinding(
    tenantId: string,
    scanId: string,
    input: {
      accountId: string;
      targetUrl: string;
      sourceUrl: string;
      verdict: ReturnType<typeof evaluateImportantLink>;
    },
  ): Promise<void> {
    const { db, now, freshnessDays } = this.#options;
    const verdict = input.verdict;
    if (verdict.result === 'no_finding') return;

    await db.withTenant(tenantId, async (tx) => {
      const rootCauseKey = `link-destination:${new URL(input.targetUrl).pathname}`;
      const evidenceRows = await listEvidenceForScan(tx, scanId);
      const assetId =
        evidenceRows.find((row) => row.capture_role === 'link_destination')?.asset_id ??
        evidenceRows[0]?.asset_id;
      if (!assetId) return;

      const finding = await insertFinding(tx, {
        id: this.#options.newId(),
        scanId,
        assetId,
        detectorId: DETECTOR_ID,
        detectorVersion: DETECTOR_VERSION,
        state: verdict.result === 'candidate' ? 'candidate' : 'unknown',
        rootCauseKey,
        claim:
          verdict.result === 'candidate'
            ? verdict.claim
            : `The link check could not be completed: ${verdict.reason.replaceAll('_', ' ')}.`,
        scope: `One linked information page reached from ${input.sourceUrl}, checked in two recorded sessions.`,
        limitations: verdict.limitations,
        evidenceGrade: verdict.result === 'candidate' ? verdict.proposed_grade : null,
        capturedAt: now().toISOString(),
        targetUrl: input.targetUrl,
        detectorOutput: verdict as unknown as Record<string, unknown>,
        evidenceFreshUntil: new Date(now().getTime() + freshnessDays * 86_400_000).toISOString(),
      });

      for (const evidenceId of verdict.evidence_ids) {
        await linkFindingEvidence(tx, {
          id: this.#options.newId(),
          findingId: finding.id,
          evidenceId,
          relationship: 'supports',
        });
      }

      // An opportunity groups by root cause, so a repeated template defect does not become
      // several competing pitches for the same underlying problem.
      const existing = await findOpportunityByAccountAndRootCause(tx, {
        accountId: input.accountId,
        rootCauseKey,
      });
      const opportunityId = existing?.id ?? this.#options.newId();
      if (!existing) {
        const scan = await getScan(tx, scanId);
        const need = aggregateNeed(
          verdict.result === 'candidate' ? [{ rootCauseKey, severity: 0.6 }] : [],
        );
        // Timing and value are genuinely unknown here, so they stay null and the score is
        // reported as an interval rather than silently treated as zero.
        const priority = scoreOpportunity({
          fit: 0.9,
          need: need.need,
          deliverability: 0.8,
          timing: null,
          value: null,
        });
        await insertOpportunity(tx, {
          id: opportunityId,
          accountId: input.accountId,
          ventureId: scan!.venture_id,
          title:
            verdict.result === 'candidate'
              ? 'Linked information page returns an error'
              : 'Link check incomplete; evidence needs review',
          priority: priority as unknown as Record<string, unknown>,
          permissionState: 'review_allowed',
          nextAction: 'review_evidence',
          ownerId: null,
        });
      }
      await linkOpportunityFinding(tx, {
        id: this.#options.newId(),
        opportunityId,
        findingId: finding.id,
      });

      await insertAuditEvent(tx, {
        id: this.#options.newId(),
        actorSubject: 'service:scan-runner',
        action: 'finding.created',
        objectType: 'finding',
        objectId: finding.id,
        objectVersion: finding.version,
        requestId: `scan:${scanId}`,
        detail: {
          detector_id: DETECTOR_ID,
          detector_version: DETECTOR_VERSION,
          verdict: verdict.result,
          reason: verdict.reason,
        },
      });
    });
  }

  /**
   * Settle the capture reservation.
   *
   * A cancelled scan keeps its reservation until the provider's state is known: a timeout is
   * not proof of zero charge. The fixture transport is the one case where zero really is
   * confirmed, because no external request was made at all.
   */
  async #settle(tenantId: string, scanId: string, actualMicro: string): Promise<void> {
    const operationKey = `scan:${scanId}:capture`;
    await this.#options.db.withTenant(tenantId, async (tx) => {
      try {
        await settleReservation(tx, { operationKey, actualMicro, providerRequestId: null });
      } catch (error) {
        this.#options.log({ event: 'settle_failed', scanId, error: String(error) });
        await markReservationUncertain(tx, operationKey).catch(() => undefined);
      }
    });
  }

  async #cancel(tenantId: string, scanId: string): Promise<{ state: string; reasons: string[] }> {
    const operationKey = `scan:${scanId}:capture`;
    const noCharge = this.#options.capture.kind === 'local_fixture';
    await this.#options.db.withTenant(tenantId, async (tx) => {
      if (noCharge) {
        await releaseReservation(tx, { operationKey, confirmedNoCharge: true }).catch(() => undefined);
      } else {
        await markReservationUncertain(tx, operationKey).catch(() => undefined);
      }
    });
    return this.#terminate(tenantId, scanId, 'cancelled', [
      noCharge
        ? 'Cancelled before any chargeable provider call. No cost was incurred.'
        : 'Cancelled. In-flight provider cost stays reserved until the provider settles it.',
    ]);
  }

  async #cancelled(tenantId: string, scanId: string): Promise<boolean> {
    return this.#options.db.withTenant(tenantId, async (tx) => {
      const scan = await getScan(tx, scanId);
      return scan?.state === 'cancel_requested';
    });
  }

  async #advance(
    tenantId: string,
    scanId: string,
    next: string,
    capturedPages?: number,
    reasons?: string[],
  ): Promise<ScanRow | null> {
    return this.#options.db.withTenant(tenantId, async (tx) => {
      const scan = await getScan(tx, scanId);
      if (!scan) return null;
      return advanceScan(tx, {
        id: scanId,
        expectedVersion: scan.version,
        nextState: next,
        ...(capturedPages !== undefined ? { capturedUniquePages: capturedPages } : {}),
        ...(reasons ? { reasons: dedupe(reasons) } : {}),
      });
    });
  }

  async #terminate(
    tenantId: string,
    scanId: string,
    state: string,
    reasons: string[],
    capturedPages?: number,
  ): Promise<{ state: string; reasons: string[] }> {
    const deduped = dedupe(reasons);
    await this.#options.db.withTenant(tenantId, async (tx) => {
      const scan = await getScan(tx, scanId);
      if (!scan || TERMINAL.has(scan.state)) return;
      const merged = dedupe([...(scan.reasons ?? []).map(String), ...deduped]);
      await advanceScan(tx, {
        id: scanId,
        expectedVersion: scan.version,
        nextState: state,
        ...(capturedPages !== undefined ? { capturedUniquePages: capturedPages } : {}),
        reasons: merged,
      });
      await insertAuditEvent(tx, {
        id: this.#options.newId(),
        actorSubject: 'service:scan-runner',
        action: `scan.${state}`,
        objectType: 'scan',
        objectId: scanId,
        objectVersion: scan.version + 1,
        requestId: `scan:${scanId}`,
        detail: { reasons: merged },
      });
    });
    return { state, reasons: deduped };
  }

  async #step(
    tenantId: string,
    scanId: string,
    stepKey: string,
    state: string,
    providerRequestId?: string,
  ): Promise<void> {
    await this.#options.db.withTenant(tenantId, async (tx) => {
      await upsertScanStep(tx, {
        id: this.#options.newId(),
        scanId,
        stepKey,
        state,
        attempt: 1,
        providerRequestId: providerRequestId ?? null,
      });
    });
  }
}

const TERMINAL = new Set(['succeeded', 'partial', 'blocked', 'failed', 'cancelled']);

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}
