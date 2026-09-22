import { randomUUID } from 'node:crypto';
import type {
  CaptureOutcome,
  CaptureProvider,
  CaptureRequest,
  ImageCapture,
  TargetPolicy,
} from '@oe/capture';
import {
  advanceScan,
  findingStatesForOpportunity,
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
  updateOpportunity,
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
  ASSET_DETECTOR_ID,
  DATA_DETECTOR_ID,
  DATA_DETECTOR_VERSION,
  MOBILE_DETECTOR_ID,
  MOBILE_DETECTOR_VERSION,
  ASSET_DETECTOR_VERSION,
  classifyLink,
  DETECTOR_ID,
  DETECTOR_VERSION,
  evaluateImportantLink,
  evaluateProductImage,
  evaluateMobileObstruction,
  evaluateStructuredData,
  nextActionForCase,
  scoreOpportunity,
  type AssetDetectorResult,
  type DataDetectorResult,
  type DataObservation,
  type ImageObservation,
  type MobileDetectorResult,
  type MobileObservation,
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

/**
 * The phone CE-MOBILE-01 measures at.
 *
 * 390×844 is a current mid-size iPhone in CSS pixels, and it is what the browser suite already
 * uses for its narrow project — so what the detector measures and what a reviewer sees in the
 * screenshot are the same screen.
 */
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const LOCALE = 'de-DE';
const LIMITS = {
  timeoutMs: 10_000,
  maxBytes: 2_000_000,
  maxHops: 3,
  // The bounded lazy-load wait. An image that has not arrived by now is pending, not broken.
  imageTimeoutMs: 2_000,
  maxImages: 12,
  maxImageBytes: 4_000_000,
};

export class ScanRunner {
  readonly #options: Required<Omit<RunnerOptions, 'log'>> & {
    log: (event: Record<string, unknown>) => void;
  };

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
        return {
          ok: false as const,
          reason: `Scan authorization is ${authorization.reason}. No capture was attempted.`,
        };
      }
      const preflight = this.#options.targetPolicy(scan.target_url, account.approved_hosts);
      if (!preflight.allowed) {
        return {
          ok: false as const,
          reason: `Target rejected by the capture policy (${preflight.reason}).`,
        };
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
    // A scan runs exactly the detectors it was admitted with, never more.
    const requested = new Set(permission.scan.detectors ?? [DETECTOR_ID]);

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
    const links = requested.has(DETECTOR_ID) ? (firstSource?.observation.links ?? []) : [];
    const candidate = links.find((link) => {
      if (classifyLink(link.text, link.href).kind !== 'important_information') return false;
      return this.#options.targetPolicy(link.href, account.approved_hosts).allowed;
    });

    let capturedPages = sourceCaptures.captured.length > 0 ? 1 : 0;
    let destinationObservations: LinkObservation[] = [];
    let destinationUrl: string | null = null;

    if (!candidate) {
      if (requested.has(DETECTOR_ID)) {
        reasons.push(
          links.length === 0
            ? 'No informational link was found on the inspected page.'
            : 'No linked information page passed the navigation policy, so none was opened.',
        );
      }
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

    // 3b · MF-ASSET-01 over the images the source page referenced. Images are subresources,
    //      so they never change the page denominator — the count is reported separately.
    const assetOutcome = requested.has(ASSET_DETECTOR_ID)
      ? await this.#detectBrokenImages(tenantId, scanId, {
          accountId: account.id,
          sourceUrl,
          images: sourceCaptures.imageObservations,
        })
      : { reasons: [], checked: 0 };
    reasons.push(...assetOutcome.reasons);

    // 3c · CE-DATA-01 over what the source page stated about itself. Like the image check,
    //      this reads the page already captured: no extra request, no extra page in the
    //      denominator.
    const dataOutcome = requested.has(DATA_DETECTOR_ID)
      ? await this.#detectStructuredDataMismatch(tenantId, scanId, {
          accountId: account.id,
          sourceUrl,
          observations: sourceCaptures.dataObservations,
        })
      : { reasons: [], checked: false };
    reasons.push(...dataOutcome.reasons);

    // 3d · CE-MOBILE-01, which needs a phone. A different viewport is a different recorded
    //      condition, so it gets its own pair of captures rather than reinterpreting the
    //      desktop ones — but it is the same page, so it does not enter the denominator.
    let mobileOutcome: { reasons: string[]; checked: boolean } = { reasons: [], checked: false };
    if (requested.has(MOBILE_DETECTOR_ID)) {
      const mobile = await this.#captureTwice({
        tenantId,
        scanId,
        url: sourceUrl,
        approvedHosts: account.approved_hosts,
        accountId: account.id,
        role: 'source_page',
        stepPrefix: 'capture:mobile',
        viewport: MOBILE_VIEWPORT,
      });
      reasons.push(...mobile.reasons);
      mobileOutcome = await this.#detectMobileObstruction(tenantId, scanId, {
        accountId: account.id,
        sourceUrl,
        observations: mobile.mobileObservations,
      });
      reasons.push(...mobileOutcome.reasons);
    }

    // 4 · Deterministic detection. Two independent, comparable, complete observations or
    //     the rule abstains — it never guesses from one capture.
    const verdict = requested.has(DETECTOR_ID)
      ? evaluateImportantLink({
          linkKind: candidate ? 'important_information' : 'unsupported',
          navigationApproved: Boolean(destinationUrl),
          target: destinationUrl ?? '',
          observations: destinationObservations,
          now: now().toISOString(),
          maxAgeMs: this.#options.freshnessDays * 86_400_000,
        })
      : null;

    if (requested.has(DETECTOR_ID)) {
      await this.#step(tenantId, scanId, `detect:${DETECTOR_ID}`, 'succeeded');
    }

    if (verdict && (verdict.result === 'candidate' || verdict.result === 'unknown')) {
      if (destinationUrl && destinationObservations.length > 0) {
        await this.#recordFinding(tenantId, scanId, {
          accountId: account.id,
          targetUrl: destinationUrl,
          verdict,
          sourceUrl,
        });
      } else if (verdict.result === 'unknown') {
        reasons.push(
          `The link check could not be completed: ${verdict.reason.replaceAll('_', ' ')}.`,
        );
      }
    } else if (verdict?.result === 'no_finding') {
      reasons.push('The linked information page loaded in both recorded checks.');
    }

    // 5 · Settle the reservation with the cost actually incurred.
    await this.#settle(tenantId, scanId, sourceCaptures.costMicro);

    const linkComplete = !requested.has(DETECTOR_ID) || destinationObservations.length >= 2;
    const assetComplete = !requested.has(ASSET_DETECTOR_ID) || assetOutcome.checked > 0;
    const dataComplete = !requested.has(DATA_DETECTOR_ID) || dataOutcome.checked;
    const mobileComplete = !requested.has(MOBILE_DETECTOR_ID) || mobileOutcome.checked;
    const complete =
      capturedPages > 0 && linkComplete && assetComplete && dataComplete && mobileComplete;
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
    /** Defaults to the desktop viewport. A different one is a different recorded condition. */
    viewport?: { width: number; height: number };
  }): Promise<{
    captured: {
      observation: NonNullable<Extract<CaptureOutcome, { status: 'captured' }>['observation']>;
    }[];
    observations: LinkObservation[];
    /** Image observations grouped by image URL, across the clean sessions. */
    imageObservations: Map<string, ImageObservation[]>;
    /** What each session read off the page: its markup, and what a person would have seen. */
    dataObservations: DataObservation[];
    /** What each session found covering the page, at the viewport it was captured in. */
    mobileObservations: MobileObservation[];
    reasons: string[];
    costMicro: string;
    fatal?: string;
  }> {
    const captured: {
      observation: NonNullable<Extract<CaptureOutcome, { status: 'captured' }>['observation']>;
    }[] = [];
    const observations: LinkObservation[] = [];
    const imageObservations = new Map<string, ImageObservation[]>();
    const dataObservations: DataObservation[] = [];
    const mobileObservations: MobileObservation[] = [];
    const reasons: string[] = [];
    let costMicro = 0n;

    // A capture at a second viewport is a third and fourth clean session of the same scan,
    // not a repeat of the first two. Distinct ordinals keep their evidence distinct — the
    // object key is unique per tenant, and reusing an ordinal would collide with the desktop
    // capture rather than sitting beside it.
    for (const ordinal of input.viewport ? ([3, 4] as const) : ([1, 2] as const)) {
      const sessionId = `${input.scanId}:${input.role}:${ordinal}`;
      const request: CaptureRequest = {
        url: input.url,
        approvedHosts: input.approvedHosts,
        sessionId,
        sessionOrdinal: ordinal,
        contextKey: 'pending',
        role: input.role,
        viewport: input.viewport ?? VIEWPORT,
        locale: LOCALE,
        operationKey: `scan:${input.scanId}:capture`,
        limits: LIMITS,
      };
      const stepKey = `${input.stepPrefix}:${ordinal}`;
      const outcome = await this.#options.capture.capture(request);

      if (outcome.status !== 'captured') {
        await this.#step(
          input.tenantId,
          input.scanId,
          stepKey,
          outcome.status === 'retryable_error' ? 'failed' : 'blocked',
        );
        const detail = `${input.role === 'source_page' ? 'The inspected page' : 'The linked information page'} could not be captured: ${outcome.detail}`;
        if (input.role === 'source_page' && ordinal === 1) {
          return {
            captured,
            observations,
            imageObservations,
            dataObservations,
            mobileObservations,
            reasons,
            costMicro: '0',
            fatal: detail,
          };
        }
        reasons.push(detail);
        continue;
      }

      costMicro += BigInt(outcome.costMicro);
      // The context key ties the two observations to the same page state. Different
      // variants are not comparable and the detector must abstain.
      const viewport = input.viewport ?? VIEWPORT;
      const contextKey = `${new URL(outcome.observation.finalUrl).pathname}|${outcome.conditions.variant ?? 'no-variant'}|${viewport.width}x${viewport.height}|${LOCALE}`;

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
      // Only the source page carries product facts worth comparing; a linked size guide is
      // not a product page and has no price to contradict.
      if (input.role === 'source_page' && outcome.observation.productFacts) {
        dataObservations.push({
          sessionId,
          evidenceId,
          capturedAt: outcome.conditions.captured_at,
          target: input.url,
          contextKey,
          structured: outcome.observation.productFacts.structured,
          visible: outcome.observation.productFacts.visible,
          pageComplete: outcome.observation.complete,
          challenge: outcome.observation.challenge,
          loginWall: outcome.observation.loginWall,
        });
      }
      if (input.role === 'source_page') {
        mobileObservations.push({
          sessionId,
          evidenceId,
          capturedAt: outcome.conditions.captured_at,
          target: input.url,
          contextKey,
          viewport,
          contentRect: outcome.observation.layout?.contentRect ?? null,
          overlays: outcome.observation.layout?.overlays ?? [],
          pageComplete: outcome.observation.complete,
          challenge: outcome.observation.challenge,
          loginWall: outcome.observation.loginWall,
        });
      }
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
      // Each referenced image becomes its own evidence row, so a finding can cite the exact
      // observation it rests on rather than a blob inside the page record.
      for (const image of outcome.observation.images) {
        const imageEvidenceId = await this.#persistImageEvidence({
          tenantId: input.tenantId,
          scanId: input.scanId,
          accountId: input.accountId,
          pageUrl: input.url,
          ordinal,
          sessionId,
          contextKey,
          capturedAt: outcome.conditions.captured_at,
          image,
        });
        const list = imageObservations.get(image.src) ?? [];
        list.push({
          sessionId,
          evidenceId: imageEvidenceId,
          capturedAt: outcome.conditions.captured_at,
          target: image.src,
          contextKey,
          role: image.role,
          resourceStatus: image.resourceStatus,
          resourceByteLength: image.resourceByteLength,
          rendered: image.rendered,
          timedOut: image.timedOut,
          lazy: image.lazy,
          pageComplete: outcome.observation.complete,
          challenge: outcome.observation.challenge,
          loginWall: outcome.observation.loginWall,
        });
        imageObservations.set(image.src, list);
      }

      await this.#step(
        input.tenantId,
        input.scanId,
        stepKey,
        'succeeded',
        outcome.providerRequestId,
      );
    }

    return {
      captured,
      observations,
      imageObservations,
      dataObservations,
      mobileObservations,
      reasons,
      costMicro: costMicro.toString(),
    };
  }

  /**
   * Persist one image observation.
   *
   * Bytes are kept when the response carried a usable image, so a reviewer can see what did
   * load; a failed request has no artifact and says so. Either way the response is hashed, so
   * the observation stays verifiable without one.
   */
  async #persistImageEvidence(input: {
    tenantId: string;
    scanId: string;
    accountId: string;
    pageUrl: string;
    ordinal: number;
    sessionId: string;
    contextKey: string;
    capturedAt: string;
    image: ImageCapture;
  }): Promise<string> {
    const { db, evidence: store, now, artifactTtlDays } = this.#options;
    const { image } = input;
    const expiresAt = new Date(now().getTime() + artifactTtlDays * 86_400_000).toISOString();
    const { createHash } = await import('node:crypto');

    let objectKey: string | null = null;
    let sha256: string;
    if (image.body && store.available) {
      const stored = await store.put({
        tenantId: input.tenantId,
        scanId: input.scanId,
        name: `image-${input.ordinal}-${hashName(image.src)}.png`,
        contentType: image.resourceContentType ?? 'application/octet-stream',
        body: image.body,
      });
      objectKey = stored.objectKey;
      sha256 = stored.sha256;
    } else {
      sha256 = createHash('sha256')
        .update(image.body ?? new Uint8Array())
        .digest('hex');
    }

    return db.withTenant(input.tenantId, async (tx) => {
      const assetId = await this.#ensureAssetFor(tx, input.accountId, image.src);
      const row = await insertEvidence(tx, {
        id: this.#options.newId(),
        scanId: input.scanId,
        assetId,
        kind: 'http_observation',
        sourceUrl: image.src,
        finalUrl: image.src,
        objectKey,
        sha256,
        conditions: {
          captured_at: input.capturedAt,
          session_id: input.sessionId,
          viewport_width: VIEWPORT.width,
          viewport_height: VIEWPORT.height,
          locale: LOCALE,
          variant: input.contextKey.split('|')[1] ?? null,
          consent_state: 'no_consent_layer_present',
          browser_version: this.#options.capture.kind,
          test_region: null,
        },
        observation: {
          referenced_by: input.pageUrl,
          role: image.role,
          role_reason: image.roleReason,
          lazy: image.lazy,
          resource_status: image.resourceStatus,
          resource_byte_length: image.resourceByteLength,
          resource_content_type: image.resourceContentType,
          timed_out: image.timedOut,
          policy_denied: image.policyDenied,
          rendered: image.rendered,
          rendered_width: image.renderedWidth,
          rendered_height: image.renderedHeight,
        },
        httpStatus: image.resourceStatus,
        // "Complete" here means the check itself finished: a 404 is a complete observation,
        // a request still outstanding when the bounded wait expired is not.
        complete: !image.timedOut && image.policyDenied === null,
        captureRole: 'product_image',
        sessionOrdinal: input.ordinal,
        contextKey: input.contextKey,
        capturedAt: input.capturedAt,
        expiresAt,
      });
      return row.id;
    });
  }

  /**
   * Run MF-ASSET-01 over every image the page referenced.
   *
   * One finding per failing image, grouped by its path so the same asset failing on repeated
   * scans is one root cause rather than a new opportunity each time.
   */
  async #detectBrokenImages(
    tenantId: string,
    scanId: string,
    input: { accountId: string; sourceUrl: string; images: Map<string, ImageObservation[]> },
  ): Promise<{ reasons: string[]; checked: number }> {
    const reasons: string[] = [];
    let checked = 0;
    let productImages = 0;

    for (const [src, observations] of input.images) {
      const verdict = evaluateProductImage({
        target: src,
        observations,
        now: this.#options.now().toISOString(),
        maxAgeMs: this.#options.freshnessDays * 86_400_000,
      });
      checked += 1;
      if (observations.some((observation) => observation.role === 'product')) productImages += 1;

      if (verdict.result === 'candidate') {
        await this.#recordAssetFinding(tenantId, scanId, { ...input, targetUrl: src, verdict });
        continue;
      }
      if (verdict.result === 'no_finding') continue;

      // Abstentions that mean "the rule does not apply here" stay silent; the evidence rows
      // are still stored and inspectable. Abstentions that mean "a product image failed and
      // we cannot say why" go to a reviewer.
      if (
        verdict.reason === 'rendered_without_resource_evidence' ||
        verdict.reason === 'inconsistent_failure_kind'
      ) {
        await this.#recordAssetFinding(tenantId, scanId, { ...input, targetUrl: src, verdict });
        continue;
      }
      if (verdict.reason === 'pending_lazy_load') {
        reasons.push(
          'An image was still loading when the bounded wait expired, so it was not judged.',
        );
      } else if (verdict.reason === 'variant_changed') {
        reasons.push(
          'The page served a different product state between checks, so its images were not compared.',
        );
      } else if (verdict.reason === 'blocked') {
        reasons.push(
          'An access check answered instead of the page, so its images were not judged.',
        );
      }
    }

    if (checked > 0) {
      reasons.push(
        `${checked} image${checked === 1 ? '' : 's'} referenced by the inspected page ${checked === 1 ? 'was' : 'were'} checked; ${productImages} classified as product content. Images are part of the page, not extra pages.`,
      );
    } else {
      reasons.push('The inspected page referenced no images.');
    }
    await this.#step(tenantId, scanId, `detect:${ASSET_DETECTOR_ID}`, 'succeeded');
    return { reasons, checked };
  }

  /**
   * Run CE-DATA-01 over what the source page stated about itself.
   *
   * One page, one comparison, at most one finding. Unlike the image rule there is nothing to
   * iterate: a product page has one price and one availability for the state it was captured
   * in, and if it has more than one the rule abstains rather than picking.
   */
  async #detectStructuredDataMismatch(
    tenantId: string,
    scanId: string,
    input: { accountId: string; sourceUrl: string; observations: DataObservation[] },
  ): Promise<{ reasons: string[]; checked: boolean }> {
    const reasons: string[] = [];
    const verdict = evaluateStructuredData({
      target: input.sourceUrl,
      observations: input.observations,
      now: this.#options.now().toISOString(),
      maxAgeMs: this.#options.freshnessDays * 86_400_000,
    });

    await this.#step(tenantId, scanId, `detect:${DATA_DETECTOR_ID}`, 'succeeded');

    if (verdict.result === 'candidate') {
      await this.#recordDataFinding(tenantId, scanId, { ...input, verdict });
      return { reasons, checked: true };
    }
    if (verdict.result === 'no_finding') {
      reasons.push('The page and its structured data stated the same facts in both checks.');
      return { reasons, checked: true };
    }

    // Abstentions that mean "this rule does not apply to this page" are reported plainly and
    // are not findings. A reader should be able to tell "we looked and it does not apply"
    // from "we did not look", which is why each one gets its own sentence.
    const explanations: Partial<Record<typeof verdict.reason, string>> = {
      structured_data_absent:
        'The page carries no structured product data, so there was nothing to compare its prices against.',
      aggregate_offer:
        'The structured data declares a price range across variants, which has no single figure to compare.',
      variant_unknown:
        'The page did not state which product variant was selected, so its markup could not be matched to it.',
      unavailable_variant_context:
        'The page and its markup describe different product states, so they were not compared.',
      multi_currency:
        'More than one currency was in view, so a difference between figures is ambiguous.',
      tax_basis_could_explain_difference:
        'The two figures differ by an amount a tax basis difference could explain, so no claim is made.',
      visible_facts_not_established:
        'Only one of the page and its markup stated a price, so there was nothing to compare.',
      stock_not_stated:
        'Only one of the page and its markup stated whether the item was in stock, so availability was not compared. The prices matched.',
      blocked: 'An access check answered instead of the page, so its facts were not judged.',
      noncomparable_context:
        'The page served a different product state between checks, so its facts were not compared.',
    };
    const explanation = explanations[verdict.reason];
    if (explanation) reasons.push(explanation);
    // `checked` stays true for an abstention that is a real answer about this page, and false
    // only when the rule could not run at all — which is what makes the scan partial.
    return {
      reasons,
      checked: explanation !== undefined || input.observations.length >= 2,
    };
  }

  /**
   * Run CE-MOBILE-01 over what the phone capture found covering the page.
   *
   * One page, one verdict. The rule's own limitations carry the important caveat — elements
   * added by JavaScript are invisible here, because captured pages are never executed — so
   * this method does not repeat it in a scan reason where it would be read as a coverage gap.
   */
  async #detectMobileObstruction(
    tenantId: string,
    scanId: string,
    input: { accountId: string; sourceUrl: string; observations: MobileObservation[] },
  ): Promise<{ reasons: string[]; checked: boolean }> {
    const reasons: string[] = [];
    const verdict = evaluateMobileObstruction({
      target: input.sourceUrl,
      observations: input.observations,
      now: this.#options.now().toISOString(),
      maxAgeMs: this.#options.freshnessDays * 86_400_000,
    });

    await this.#step(tenantId, scanId, `detect:${MOBILE_DETECTOR_ID}`, 'succeeded');

    if (verdict.result === 'candidate') {
      await this.#recordMobileFinding(tenantId, scanId, { ...input, verdict });
      return { reasons, checked: true };
    }
    if (verdict.result === 'no_finding') {
      reasons.push(
        'Nothing covered the page at the recorded phone viewport. The same page at one more viewport is not an extra page.',
      );
      return { reasons, checked: true };
    }

    const explanations: Partial<Record<typeof verdict.reason, string>> = {
      user_dismissible_overlay_not_tested:
        'Something covered the page on a phone, but it carried a visible way to close it and nothing was tapped, so no claim is made.',
      transient_loading:
        'What covered the page announced itself as a loading state, so it was not treated as an obstruction.',
      missing_viewport:
        'No viewport was recorded for the phone capture, so nothing could be measured against it.',
      content_region_not_established:
        'The page exposes no main content region, so there was nothing to measure an obstruction against.',
      obstruction_not_repeated:
        'Something covered the page in one check and not the other, so it was not treated as persistent.',
      blocked: 'An access check answered instead of the page, so its layout was not judged.',
      noncomparable_context:
        'The page served a different state between phone checks, so its layout was not compared.',
    };
    const explanation = explanations[verdict.reason];
    if (explanation) reasons.push(explanation);
    return { reasons, checked: explanation !== undefined || input.observations.length >= 2 };
  }

  async #recordMobileFinding(
    tenantId: string,
    scanId: string,
    input: { accountId: string; sourceUrl: string; verdict: MobileDetectorResult },
  ): Promise<void> {
    const { db, now, freshnessDays } = this.#options;
    const verdict = input.verdict;
    if (verdict.result !== 'candidate') return;

    await db.withTenant(tenantId, async (tx) => {
      const rootCauseKey = `mobile-obstruction:${new URL(input.sourceUrl).pathname}`;
      const evidenceRows = await listEvidenceForScan(tx, scanId);
      const assetId =
        evidenceRows.find((row) => row.source_url === input.sourceUrl)?.asset_id ??
        evidenceRows[0]?.asset_id;
      if (!assetId) return;

      const finding = await insertFinding(tx, {
        id: this.#options.newId(),
        scanId,
        assetId,
        detectorId: MOBILE_DETECTOR_ID,
        detectorVersion: MOBILE_DETECTOR_VERSION,
        state: 'candidate',
        rootCauseKey,
        claim: verdict.claim,
        scope: `The page at ${input.sourceUrl}, as it arrived at a phone viewport, in two recorded sessions.`,
        limitations: verdict.limitations,
        evidenceGrade: verdict.proposed_grade,
        capturedAt: now().toISOString(),
        targetUrl: input.sourceUrl,
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

      const existing = await findOpportunityByAccountAndRootCause(tx, {
        accountId: input.accountId,
        rootCauseKey,
      });
      const opportunityId = existing?.id ?? this.#options.newId();
      if (!existing) {
        const scan = await getScan(tx, scanId);
        const need = aggregateNeed([{ rootCauseKey, severity: 0.5 }]);
        const priority = scoreOpportunity({
          fit: 0.9,
          need: need.need,
          deliverability: 0.7,
          timing: null,
          value: null,
        });
        await insertOpportunity(tx, {
          id: opportunityId,
          accountId: input.accountId,
          ventureId: scan!.venture_id,
          title: 'Something covers the page on a phone',
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
      if (existing) {
        const nextAction = nextActionForCase({
          findingStates: await findingStatesForOpportunity(tx, opportunityId),
          current: existing.next_action,
        });
        if (nextAction !== existing.next_action) {
          await updateOpportunity(tx, { id: opportunityId, nextAction });
        }
      }

      await insertAuditEvent(tx, {
        id: this.#options.newId(),
        actorSubject: 'service:scan-runner',
        action: 'finding.created',
        objectType: 'finding',
        objectId: finding.id,
        objectVersion: finding.version,
        requestId: `scan:${scanId}`,
        detail: {
          detector_id: MOBILE_DETECTOR_ID,
          detector_version: MOBILE_DETECTOR_VERSION,
          root_cause_key: rootCauseKey,
        },
      });
    });
  }

  async #recordDataFinding(
    tenantId: string,
    scanId: string,
    input: { accountId: string; sourceUrl: string; verdict: DataDetectorResult },
  ): Promise<void> {
    const { db, now, freshnessDays } = this.#options;
    const verdict = input.verdict;
    if (verdict.result !== 'candidate') return;

    await db.withTenant(tenantId, async (tx) => {
      // Grouped by page and by what disagreed: the same page contradicting itself about price
      // on two scans is one root cause, and a separate stock contradiction is another.
      const rootCauseKey = `product-data:${new URL(input.sourceUrl).pathname}:${verdict.reason}`;
      const evidenceRows = await listEvidenceForScan(tx, scanId);
      const assetId =
        evidenceRows.find((row) => row.source_url === input.sourceUrl)?.asset_id ??
        evidenceRows[0]?.asset_id;
      if (!assetId) return;

      const finding = await insertFinding(tx, {
        id: this.#options.newId(),
        scanId,
        assetId,
        detectorId: DATA_DETECTOR_ID,
        detectorVersion: DATA_DETECTOR_VERSION,
        state: 'candidate',
        rootCauseKey,
        claim: verdict.claim,
        scope: `The page at ${input.sourceUrl}, in the product state it was captured in, checked in two recorded sessions.`,
        limitations: verdict.limitations,
        evidenceGrade: verdict.proposed_grade,
        capturedAt: now().toISOString(),
        targetUrl: input.sourceUrl,
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

      const existing = await findOpportunityByAccountAndRootCause(tx, {
        accountId: input.accountId,
        rootCauseKey,
      });
      const opportunityId = existing?.id ?? this.#options.newId();
      if (!existing) {
        const scan = await getScan(tx, scanId);
        const need = aggregateNeed([{ rootCauseKey, severity: 0.5 }]);
        const priority = scoreOpportunity({
          fit: 0.9,
          need: need.need,
          // Lower than a broken link or image: this rule says two statements disagree, not
          // which is wrong, so the work it implies is a diagnosis before it is a repair.
          deliverability: 0.6,
          timing: null,
          value: null,
        });
        await insertOpportunity(tx, {
          id: opportunityId,
          accountId: input.accountId,
          ventureId: scan!.venture_id,
          title:
            verdict.reason === 'price_mismatch'
              ? 'Page and structured data state different prices'
              : 'Page and structured data state different availability',
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
      if (existing) {
        const nextAction = nextActionForCase({
          findingStates: await findingStatesForOpportunity(tx, opportunityId),
          current: existing.next_action,
        });
        if (nextAction !== existing.next_action) {
          await updateOpportunity(tx, { id: opportunityId, nextAction });
        }
      }

      await insertAuditEvent(tx, {
        id: this.#options.newId(),
        actorSubject: 'service:scan-runner',
        action: 'finding.created',
        objectType: 'finding',
        objectId: finding.id,
        objectVersion: finding.version,
        requestId: `scan:${scanId}`,
        detail: {
          detector_id: DATA_DETECTOR_ID,
          detector_version: DATA_DETECTOR_VERSION,
          reason: verdict.reason,
          root_cause_key: rootCauseKey,
        },
      });
    });
  }

  async #recordAssetFinding(
    tenantId: string,
    scanId: string,
    input: {
      accountId: string;
      sourceUrl: string;
      targetUrl: string;
      verdict: AssetDetectorResult;
    },
  ): Promise<void> {
    const { db, now, freshnessDays } = this.#options;
    const verdict = input.verdict;
    if (verdict.result === 'no_finding') return;

    await db.withTenant(tenantId, async (tx) => {
      // Group by the asset's path: the same image failing across scans is one root cause.
      const rootCauseKey = `product-image:${new URL(input.targetUrl).pathname}`;
      const evidenceRows = await listEvidenceForScan(tx, scanId);
      const assetId =
        evidenceRows.find((row) => row.source_url === input.targetUrl)?.asset_id ??
        evidenceRows[0]?.asset_id;
      if (!assetId) return;

      const finding = await insertFinding(tx, {
        id: this.#options.newId(),
        scanId,
        assetId,
        detectorId: ASSET_DETECTOR_ID,
        detectorVersion: ASSET_DETECTOR_VERSION,
        state: verdict.result === 'candidate' ? 'candidate' : 'unknown',
        rootCauseKey,
        claim:
          verdict.result === 'candidate'
            ? verdict.claim
            : `A product image did not render and the cause could not be established: ${verdict.reason.replaceAll('_', ' ')}.`,
        scope: `One image referenced by ${input.sourceUrl}, checked in two recorded sessions at one viewport.`,
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

      const existing = await findOpportunityByAccountAndRootCause(tx, {
        accountId: input.accountId,
        rootCauseKey,
      });
      const opportunityId = existing?.id ?? this.#options.newId();
      if (!existing) {
        const scan = await getScan(tx, scanId);
        const need = aggregateNeed(
          verdict.result === 'candidate' ? [{ rootCauseKey, severity: 0.55 }] : [],
        );
        const priority = scoreOpportunity({
          fit: 0.9,
          need: need.need,
          deliverability: 0.75,
          timing: null,
          value: null,
        });
        await insertOpportunity(tx, {
          id: opportunityId,
          accountId: input.accountId,
          ventureId: scan!.venture_id,
          title:
            verdict.result === 'candidate'
              ? 'Product image does not load'
              : 'Product image check incomplete; evidence needs review',
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
      // A new undecided finding puts an existing case back in the review queue. Without this
      // a case that had been confirmed and moved on to `draft_offer` would keep a fresh
      // candidate hidden behind a next step nobody can take yet.
      if (existing) {
        const nextAction = nextActionForCase({
          findingStates: await findingStatesForOpportunity(tx, opportunityId),
          current: existing.next_action,
        });
        if (nextAction !== existing.next_action) {
          await updateOpportunity(tx, { id: opportunityId, nextAction });
        }
      }

      await insertAuditEvent(tx, {
        id: this.#options.newId(),
        actorSubject: 'service:scan-runner',
        action: 'finding.created',
        objectType: 'finding',
        objectId: finding.id,
        objectVersion: finding.version,
        requestId: `scan:${scanId}`,
        detail: {
          detector_id: ASSET_DETECTOR_ID,
          detector_version: ASSET_DETECTOR_VERSION,
          verdict: verdict.result,
          reason: verdict.reason,
        },
      });
    });
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
      // A new undecided finding puts an existing case back in the review queue. Without this
      // a case that had been confirmed and moved on to `draft_offer` would keep a fresh
      // candidate hidden behind a next step nobody can take yet.
      if (existing) {
        const nextAction = nextActionForCase({
          findingStates: await findingStatesForOpportunity(tx, opportunityId),
          current: existing.next_action,
        });
        if (nextAction !== existing.next_action) {
          await updateOpportunity(tx, { id: opportunityId, nextAction });
        }
      }

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
        await releaseReservation(tx, { operationKey, confirmedNoCharge: true }).catch(
          () => undefined,
        );
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

/** A short, stable token from an image URL, so two images on a page get distinct object keys. */
function hashName(url: string): string {
  let hash = 0;
  for (let index = 0; index < url.length; index += 1) {
    hash = (hash * 31 + url.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}
