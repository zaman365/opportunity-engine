import { Hono } from 'hono';
import {
  Account as AccountSchema,
  ChangeBudget,
  CreateAccount,
  CreateReport as CreateReportSchema,
  CreateScan as CreateScanSchema,
  AuthorizationInput,
  ExpectedVersion,
  PauseBudget,
  ReviewFinding as ReviewFindingSchema,
  type Session,
} from '@oe/contracts';
import { missingBindings, transition, TransitionError } from '@oe/domain';
import {
  advanceReport,
  advanceScan,
  configureBudget,
  findingEvidenceIds,
  getAccount,
  getBudget,
  getEvidence,
  getFinding,
  getOpportunity,
  getReport,
  getScan,
  insertAccount,
  insertAuditEvent,
  insertAuthorization,
  LedgerError,
  listAuthorizations,
  listAccounts,
  listBudgets,
  listEvidenceByIds,
  listEvidenceForScan,
  listFindingsForScan,
  listOpportunities,
  listReportFindings,
  listScanSteps,
  listScans,
  listReviews,
  setBudgetPaused,
  type ScanRow,
  type QueryExecutor,
} from '@oe/db';
import type { AppDependencies, AppEnv, RequestActor } from './context.ts';
import { ApiProblem, problemResponse } from './problem.ts';
import {
  authenticate,
  csrfGuard,
  idempotencyInput,
  readJsonBody,
  requestId as requestIdMiddleware,
  requireRole,
  securityHeaders,
} from './middleware.ts';
import {
  decodeCursor,
  encodeCursor,
  toAccount,
  toAuthorization,
  toBudget,
  toEvidence,
  toFinding,
  toOpportunity,
  toReport,
  toScan,
  type ScanCostSnapshot,
} from './projections.ts';
import { admitScan, ledgerProblem } from './services/scan-admission.ts';
import { reviewFinding } from './services/review.ts';
import { assertPublishable, createReport } from './services/report.ts';
import { completeIdempotencyKey } from '@oe/db';

/**
 * The internal operator API.
 *
 * Routes mirror `contracts/openapi.json`; `tests/contract/openapi-routes.test.ts` asserts
 * that the set of implemented routes and their minimum roles match that document, so a
 * route cannot drift from the contract silently.
 */
export function createApp(deps: AppDependencies) {
  const app = new Hono<AppEnv>();

  app.use('*', requestIdMiddleware);
  app.use('*', securityHeaders);

  app.onError((error, c) => {
    const id = c.get('requestId') ?? 'unknown';
    if (error instanceof ApiProblem) return problemResponse(error, id);
    if (error instanceof LedgerError) return problemResponse(ledgerProblem(error), id);
    // Anything unexpected becomes a generic 503 with a request ID. No stack, no provider
    // message, no database constraint text reaches the client (SECURITY.md).
    console.error(`[${id}] unhandled`, error);
    return problemResponse(
      new ApiProblem('DEPENDENCY_UNAVAILABLE', 'The request could not be completed. Quote the request ID.'),
      id,
    );
  });

  app.notFound((c) =>
    problemResponse(new ApiProblem('NOT_FOUND', 'No such endpoint.'), c.get('requestId') ?? 'unknown'),
  );

  /* ------------------------------------------------------------ health */

  // Liveness: the process answers. It says nothing about dependencies.
  app.get('/api/health', (c) => c.json({ status: 'healthy' as const, environment: deps.config.environment, missing_bindings: [] }));

  // Readiness: which bindings a request would need and does not have. No money is spent and
  // no provider is contacted to answer it.
  app.get('/api/ready', (c) => {
    const missing = missingBindings(deps.config);
    return c.json(
      {
        status: missing.length === 0 ? ('healthy' as const) : ('not_ready' as const),
        environment: deps.config.environment,
        missing_bindings: missing,
      },
      missing.length === 0 ? 200 : 503,
    );
  });

  const v1 = new Hono<AppEnv>();
  v1.use('*', authenticate(deps));
  v1.use('*', csrfGuard(deps));

  /* ----------------------------------------------------------- session */

  v1.get('/session', requireRole('viewer'), (c) => {
    const actor = c.get('actor');
    const session: Session = {
      subject: actor.identity.subject,
      active_tenant_id: actor.membership.tenantId,
      role: actor.membership.role,
      venture_ids: actor.membership.ventureIds,
      csrf_token: deps.csrf.issue(actor.identity),
      environment: deps.config.environment,
    };
    return c.json(session);
  });

  /* ---------------------------------------------------------- accounts */

  v1.get('/accounts', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const { limit, cursor } = listParams(c.req.query('limit'), c.req.query('cursor'));
    const rows = await deps.db.withTenant(actor.membership.tenantId, (tx) =>
      listAccounts(tx, {
        ventureIds: actor.membership.ventureIds,
        limit,
        cursor: cursor ? { createdAt: cursor.timestamp, id: cursor.id } : null,
      }),
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return c.json({
      items: page.map(toAccount),
      next_cursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    });
  });

  v1.post('/accounts', requireRole('owner'), async (c) => {
    const actor = c.get('actor');
    const body = parse(CreateAccount, await readJsonBody(c.req.raw));
    const { key, requestHash } = idempotencyInput(c.req.header('idempotency-key'), body);
    if (!actor.membership.ventureIds.includes(body.venture_id)) {
      throw new ApiProblem('VENTURE_NOT_ASSIGNED', 'This membership is not assigned to that venture.');
    }
    // An approved host must be a real public hostname; the account row is the allowlist the
    // scan policy later trusts, so a bad value here would widen every future scan.
    for (const host of body.approved_hosts) {
      if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host.startsWith('-')) {
        throw new ApiProblem('INVALID_REQUEST', `"${host}" is not a valid approved hostname.`);
      }
    }
    const created = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const claim = await claimOrReplay(tx, deps, actor, 'createAccount', key, requestHash);
      if (claim.replay) return claim.replay;
      const row = await insertAccount(tx, {
        id: deps.newId(),
        ventureId: body.venture_id,
        name: body.name,
        canonicalDomain: body.canonical_domain,
        approvedHosts: [...body.approved_hosts],
        sourceNote: body.source_note,
      });
      const account = toAccount(row);
      await insertAuditEvent(tx, {
        id: deps.newId(),
        actorSubject: actor.identity.subject,
        action: 'account.created',
        objectType: 'account',
        objectId: row.id,
        objectVersion: row.version,
        requestId: c.get('requestId'),
        detail: { canonical_domain: row.canonical_domain, approved_host_count: row.approved_hosts.length },
      });
      await completeIdempotencyKey(tx, { recordId: claim.recordId, responseStatus: 201, responseBody: account });
      return { status: 201, body: account };
    });
    return c.json(created.body as object, 201);
  });

  v1.post('/accounts/:id/authorizations', requireRole('owner'), async (c) => {
    const actor = c.get('actor');
    const accountId = uuidParam(c.req.param('id'));
    const body = parse(AuthorizationInput, await readJsonBody(c.req.raw));
    const { key, requestHash } = idempotencyInput(c.req.header('idempotency-key'), { accountId, ...body });
    const expiresAt = Date.parse(body.expires_at);
    if (expiresAt <= deps.now().getTime()) {
      throw new ApiProblem('INVALID_REQUEST', 'An authorization must expire in the future.');
    }
    const created = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const claim = await claimOrReplay(tx, deps, actor, 'createAuthorization', key, requestHash);
      if (claim.replay) return claim.replay;
      const account = await getAccount(tx, accountId);
      if (!account) throw new ApiProblem('NOT_FOUND', 'No such account in this workspace.');
      const row = await insertAuthorization(tx, {
        id: deps.newId(),
        accountId,
        action: body.action,
        purpose: body.purpose,
        evidenceNote: body.evidence_note,
        policyVersion: body.policy_version,
        grantedBy: actor.membership.membershipId,
        expiresAt: body.expires_at,
      });
      const authorization = toAuthorization(row);
      await insertAuditEvent(tx, {
        id: deps.newId(),
        actorSubject: actor.identity.subject,
        action: 'authorization.granted',
        objectType: 'authorization',
        objectId: row.id,
        objectVersion: null,
        requestId: c.get('requestId'),
        detail: { account_id: accountId, action: body.action, policy_version: body.policy_version },
      });
      await completeIdempotencyKey(tx, {
        recordId: claim.recordId,
        responseStatus: 201,
        responseBody: authorization,
      });
      return { status: 201, body: authorization };
    });
    return c.json(created.body as object, 201);
  });

  /* ------------------------------------------------------------- scans */

  v1.get('/scans', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const { limit, cursor } = listParams(c.req.query('limit'), c.req.query('cursor'));
    const result = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const rows = await listScans(tx, {
        ventureIds: actor.membership.ventureIds,
        limit,
        cursor: cursor ? { createdAt: cursor.timestamp, id: cursor.id } : null,
      });
      const page = rows.slice(0, limit);
      const items = [];
      for (const row of page) items.push(await projectScan(tx, deps, row));
      return { items, more: rows.length > limit, last: page.at(-1) };
    });
    return c.json({
      items: result.items,
      next_cursor: result.more && result.last ? encodeCursor(result.last.created_at, result.last.id) : null,
    });
  });

  v1.post('/scans', requireRole('operator'), async (c) => {
    const actor = c.get('actor');
    const body = parse(CreateScanSchema, await readJsonBody(c.req.raw));
    const { key, requestHash } = idempotencyInput(c.req.header('idempotency-key'), body);

    // Feature readiness before admission: an unconfigured provider is a 503, not a scan that
    // is admitted and then quietly blocked.
    if (!deps.capture.configured) {
      throw new ApiProblem(
        'PROVIDER_NOT_CONFIGURED',
        'Live capture is not configured. No scan has been performed.',
      );
    }

    const price = {
      currency: actor.membership.ledgerCurrency,
      // The local fixture transport makes no paid provider call. The reservation path still
      // runs, so the ledger is exercised rather than bypassed.
      worstCaseMicro: deps.capture.kind === 'local_fixture' ? '0' : deps.config.liveSpendLimitMicro,
      source: `adapter:${deps.capture.kind}`,
    };

    const outcome = await deps.db.withTenantRetry(actor.membership.tenantId, async (tx) => {
      const result = await admitScan(tx, deps, {
        actor,
        request: body,
        idempotencyKey: key,
        requestHash,
        requestId: c.get('requestId'),
        price,
      });
      if (result.replayed && result.storedResponse) return result.storedResponse;
      const scan = await projectScan(tx, deps, result.scan);
      await completeIdempotencyKey(tx, {
        recordId: result.idempotencyRecordId,
        responseStatus: 202,
        responseBody: scan,
      });
      return { status: 202, body: scan };
    });

    // Only after the transaction committed may anything chargeable be scheduled.
    if (outcome.status === 202) {
      const admitted = outcome.body as { id: string };
      deps.onScanAdmitted?.({ tenantId: actor.membership.tenantId, scanId: admitted.id });
    }
    return c.json(outcome.body as object, outcome.status as 202);
  });

  v1.get('/scans/:id', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const id = uuidParam(c.req.param('id'));
    const scan = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const row = await getScan(tx, id);
      if (!row) throw new ApiProblem('NOT_FOUND', 'No such scan in this workspace.');
      assertVenture(actor, row.venture_id);
      return projectScan(tx, deps, row);
    });
    return c.json(scan);
  });

  v1.post('/scans/:id/cancel', requireRole('operator'), async (c) => {
    const actor = c.get('actor');
    const id = uuidParam(c.req.param('id'));
    const body = parse(ExpectedVersion, await readJsonBody(c.req.raw));
    const { key, requestHash } = idempotencyInput(c.req.header('idempotency-key'), { id, ...body });
    const result = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const claim = await claimOrReplay(tx, deps, actor, 'cancelScan', key, requestHash);
      if (claim.replay) return claim.replay;
      const row = await getScan(tx, id);
      if (!row) throw new ApiProblem('NOT_FOUND', 'No such scan in this workspace.');
      assertVenture(actor, row.venture_id);
      try {
        transition({
          kind: 'scan',
          state: row.state,
          version: row.version,
          expectedVersion: body.expected_version,
          next: 'cancel_requested',
        });
      } catch (error) {
        throw transitionProblem(error, row.state, 'cancel_requested', row.version);
      }
      const updated = await advanceScan(tx, {
        id,
        expectedVersion: body.expected_version,
        nextState: 'cancel_requested',
        // COPY.md: stopping new work does not undo cost already incurred.
        reasons: [...(row.reasons ?? []).map(String), 'Cancellation requested by operator. In-flight provider cost may still settle.'],
        cancelRequestedAt: deps.now().toISOString(),
      });
      if (!updated) throw new ApiProblem('VERSION_CONFLICT', 'The scan changed since it was read. Reload and retry.');
      await insertAuditEvent(tx, {
        id: deps.newId(),
        actorSubject: actor.identity.subject,
        action: 'scan.cancel_requested',
        objectType: 'scan',
        objectId: id,
        objectVersion: updated.version,
        requestId: c.get('requestId'),
        detail: { from_state: row.state },
      });
      const scan = await projectScan(tx, deps, updated);
      await completeIdempotencyKey(tx, { recordId: claim.recordId, responseStatus: 202, responseBody: scan });
      return { status: 202, body: scan };
    });
    return c.json(result.body as object, 202);
  });

  /* ---------------------------------------------------------- evidence */

  v1.get('/evidence/:id', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const id = uuidParam(c.req.param('id'));
    const evidence = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const row = await getEvidence(tx, id);
      if (!row) throw new ApiProblem('NOT_FOUND', 'No such evidence in this workspace.');
      const scan = await getScan(tx, row.scan_id);
      if (!scan) throw new ApiProblem('NOT_FOUND', 'No such evidence in this workspace.');
      assertVenture(actor, scan.venture_id);
      return toEvidence(row, Boolean(row.object_key) && deps.evidence.available && !row.redacted);
    });
    return c.json(evidence);
  });

  v1.get('/evidence/:id/content', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const id = uuidParam(c.req.param('id'));
    const found = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const row = await getEvidence(tx, id);
      if (!row) throw new ApiProblem('NOT_FOUND', 'No such evidence in this workspace.');
      const scan = await getScan(tx, row.scan_id);
      if (!scan) throw new ApiProblem('NOT_FOUND', 'No such evidence in this workspace.');
      assertVenture(actor, scan.venture_id);
      return row;
    });
    if (found.redacted) {
      throw new ApiProblem('NOT_FOUND', 'This artifact was redacted and its bytes are no longer available.');
    }
    if (Date.parse(found.expires_at) <= deps.now().getTime()) {
      throw new ApiProblem('NOT_FOUND', 'This artifact passed its retention date and is no longer stored.');
    }
    if (!found.object_key) {
      throw new ApiProblem('NOT_FOUND', 'No artifact was stored for this observation.');
    }
    const object = await deps.evidence.get({
      tenantId: actor.membership.tenantId,
      objectKey: found.object_key,
    });
    if (!object) throw new ApiProblem('NOT_FOUND', 'The artifact is no longer retrievable.');
    return new Response(object.body, {
      headers: {
        // Raster only. An HTML artifact is never served into the operator origin
        // (SECURITY.md); it downloads as an inert attachment instead.
        'content-type': object.contentType.startsWith('image/') ? object.contentType : 'application/octet-stream',
        'content-disposition': object.contentType.startsWith('image/') ? 'inline' : 'attachment',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  });

  /* ----------------------------------------------------- opportunities */

  v1.get('/opportunities', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const { limit, cursor } = listParams(c.req.query('limit'), c.req.query('cursor'));
    const result = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const rows = await listOpportunities(tx, {
        ventureIds: actor.membership.ventureIds,
        limit,
        cursor: cursor ? { updatedAt: cursor.timestamp, id: cursor.id } : null,
      });
      const page = rows.slice(0, limit);
      const items = [];
      for (const row of page) {
        const account = await getAccount(tx, row.account_id);
        if (!account) continue;
        items.push(toOpportunity(row, toAccount(account)));
      }
      return { items, more: rows.length > limit, last: page.at(-1) };
    });
    return c.json({
      items: result.items,
      next_cursor: result.more && result.last ? encodeCursor(result.last.updated_at, result.last.id) : null,
    });
  });

  v1.get('/opportunities/:id', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const id = uuidParam(c.req.param('id'));
    const detail = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const row = await getOpportunity(tx, id);
      if (!row) throw new ApiProblem('NOT_FOUND', 'No such opportunity in this workspace.');
      assertVenture(actor, row.venture_id);
      const account = await getAccount(tx, row.account_id);
      if (!account) throw new ApiProblem('NOT_FOUND', 'No such opportunity in this workspace.');
      const findings = [];
      const evidenceIds = new Set<string>();
      for (const findingId of row.finding_ids) {
        const finding = await getFinding(tx, findingId);
        if (!finding) continue;
        const links = await findingEvidenceIds(tx, finding.id);
        for (const evidenceId of [...links.supports, ...links.contradicts]) evidenceIds.add(evidenceId);
        findings.push(toFinding(finding, links.supports, links.contradicts));
      }
      const evidence = await listEvidenceByIds(tx, [...evidenceIds]);
      return {
        opportunity: toOpportunity(row, toAccount(account)),
        findings,
        evidence: evidence.map((e) =>
          toEvidence(e, Boolean(e.object_key) && deps.evidence.available && !e.redacted),
        ),
      };
    });
    return c.json(detail);
  });

  /* ---------------------------------------------------------- findings */

  v1.get('/findings/:id', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const id = uuidParam(c.req.param('id'));
    const detail = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const finding = await getFinding(tx, id);
      if (!finding) throw new ApiProblem('NOT_FOUND', 'No such finding in this workspace.');
      const scan = await getScan(tx, finding.scan_id);
      if (!scan) throw new ApiProblem('NOT_FOUND', 'No such finding in this workspace.');
      assertVenture(actor, scan.venture_id);
      const links = await findingEvidenceIds(tx, finding.id);
      const evidence = await listEvidenceByIds(tx, [...links.supports, ...links.contradicts]);
      return {
        finding: toFinding(finding, links.supports, links.contradicts),
        evidence: evidence.map((e) =>
          toEvidence(e, Boolean(e.object_key) && deps.evidence.available && !e.redacted),
        ),
      };
    });
    return c.json(detail);
  });

  v1.post('/findings/:id/review', requireRole('reviewer'), async (c) => {
    const actor = c.get('actor');
    const id = uuidParam(c.req.param('id'));
    const body = parse(ReviewFindingSchema, await readJsonBody(c.req.raw));
    const { key, requestHash } = idempotencyInput(c.req.header('idempotency-key'), { id, ...body });
    const result = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const claim = await claimOrReplay(tx, deps, actor, 'reviewFinding', key, requestHash);
      if (claim.replay) return claim.replay;
      const finding = await getFinding(tx, id);
      if (!finding) throw new ApiProblem('NOT_FOUND', 'No such finding in this workspace.');
      const scan = await getScan(tx, finding.scan_id);
      if (!scan) throw new ApiProblem('NOT_FOUND', 'No such finding in this workspace.');
      assertVenture(actor, scan.venture_id);
      const updated = await reviewFinding(tx, deps, {
        actor,
        findingId: id,
        body,
        requestId: c.get('requestId'),
      });
      const links = await findingEvidenceIds(tx, updated.id);
      const projected = toFinding(updated, links.supports, links.contradicts);
      await completeIdempotencyKey(tx, { recordId: claim.recordId, responseStatus: 200, responseBody: projected });
      return { status: 200, body: projected };
    });
    return c.json(result.body as object, 200);
  });

  /* ----------------------------------------------------------- reports */

  v1.post('/reports', requireRole('reviewer'), async (c) => {
    const actor = c.get('actor');
    const body = parse(CreateReportSchema, await readJsonBody(c.req.raw));
    const { key, requestHash } = idempotencyInput(c.req.header('idempotency-key'), body);
    const result = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const claim = await claimOrReplay(tx, deps, actor, 'createReport', key, requestHash);
      if (claim.replay) return claim.replay;
      const created = await createReport(tx, deps, { actor, body, requestId: c.get('requestId') });
      const bound = await listReportFindings(tx, created.row.id);
      const report = toReport(created.row, bound);
      await completeIdempotencyKey(tx, { recordId: claim.recordId, responseStatus: 201, responseBody: report });
      return { status: 201, body: report };
    });
    return c.json(result.body as object, 201);
  });

  v1.get('/reports/:id', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const id = uuidParam(c.req.param('id'));
    const payload = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const row = await getReport(tx, id);
      if (!row) throw new ApiProblem('NOT_FOUND', 'No such report in this workspace.');
      const account = await getAccount(tx, row.account_id);
      if (!account) throw new ApiProblem('NOT_FOUND', 'No such report in this workspace.');
      assertVenture(actor, account.venture_id);
      const bound = await listReportFindings(tx, row.id);
      // UI_SPEC.md: "revoked link shows a neutral unavailable message without leaking
      // tenant/customer data" — so the body is withheld while the metadata still explains
      // the state to an authorised operator.
      const body = row.state === 'revoked' ? null : row.body;
      return { ...toReport(row, bound), body, body_sha256: row.body_sha256 };
    });
    return c.json(payload);
  });

  for (const [path, next] of [
    ['approve', 'approved'],
    ['publish', 'published'],
    ['revoke', 'revoked'],
  ] as const) {
    v1.post(`/reports/:id/${path}`, requireRole('reviewer'), async (c) => {
      const actor = c.get('actor');
      const id = uuidParam(c.req.param('id'));
      const body = parse(ExpectedVersion, await readJsonBody(c.req.raw));
      const { key, requestHash } = idempotencyInput(c.req.header('idempotency-key'), { id, path, ...body });
      const result = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
        const claim = await claimOrReplay(tx, deps, actor, `report.${path}`, key, requestHash);
        if (claim.replay) return claim.replay;
        const row = await getReport(tx, id);
        if (!row) throw new ApiProblem('NOT_FOUND', 'No such report in this workspace.');
        const account = await getAccount(tx, row.account_id);
        if (!account) throw new ApiProblem('NOT_FOUND', 'No such report in this workspace.');
        assertVenture(actor, account.venture_id);
        try {
          transition({
            kind: 'report',
            state: row.state,
            version: row.version,
            expectedVersion: body.expected_version,
            next,
          });
        } catch (error) {
          throw transitionProblem(error, row.state, next, row.version);
        }
        const bound = await listReportFindings(tx, row.id);
        if (next === 'published') {
          // Re-verify every bound version in this same transaction, per API_GUIDE.md.
          await assertPublishable(tx, deps, row.id, bound);
        }
        const updated = await advanceReport(tx, {
          id,
          expectedVersion: body.expected_version,
          nextState: next,
          at: deps.now().toISOString(),
          ...(next === 'revoked' ? { revokeReason: 'Revoked by reviewer.' } : {}),
        });
        if (!updated) {
          throw new ApiProblem('VERSION_CONFLICT', 'The report changed since it was read. Reload and retry.');
        }
        await insertAuditEvent(tx, {
          id: deps.newId(),
          actorSubject: actor.identity.subject,
          action: `report.${path}`,
          objectType: 'report',
          objectId: id,
          objectVersion: updated.version,
          requestId: c.get('requestId'),
          detail: { from_state: row.state, to_state: next, body_sha256: updated.body_sha256 },
        });
        const report = toReport(updated, bound);
        await completeIdempotencyKey(tx, { recordId: claim.recordId, responseStatus: 200, responseBody: report });
        return { status: 200, body: report };
      });
      return c.json(result.body as object, 200);
    });
  }

  /* ----------------------------------------------------------- budgets */

  v1.get('/budgets', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const rows = await deps.db.withTenant(actor.membership.tenantId, (tx) => listBudgets(tx));
    return c.json({ items: rows.map(toBudget), next_cursor: null });
  });

  v1.patch('/budgets/:id', requireRole('owner'), async (c) => {
    const actor = c.get('actor');
    const id = uuidParam(c.req.param('id'));
    const body = parse(ChangeBudget, await readJsonBody(c.req.raw));
    const { key, requestHash } = idempotencyInput(c.req.header('idempotency-key'), { id, ...body });
    const result = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const claim = await claimOrReplay(tx, deps, actor, 'changeBudget', key, requestHash);
      if (claim.replay) return claim.replay;
      await configureBudget(tx, {
        budgetId: id,
        expectedVersion: body.expected_version,
        limitMicro: body.limit.amount_micro,
        currency: body.limit.currency,
      });
      const updated = await getBudget(tx, id);
      if (!updated) throw new ApiProblem('NOT_FOUND', 'No such cost limit in this workspace.');
      await insertAuditEvent(tx, {
        id: deps.newId(),
        actorSubject: actor.identity.subject,
        action: 'budget.limit_changed',
        objectType: 'budget',
        objectId: id,
        objectVersion: updated.version,
        requestId: c.get('requestId'),
        detail: { limit_micro: updated.limit_micro, currency: updated.currency, reason: body.reason },
      });
      const budget = toBudget(updated);
      await completeIdempotencyKey(tx, { recordId: claim.recordId, responseStatus: 200, responseBody: budget });
      return { status: 200, body: budget };
    });
    return c.json(result.body as object, 200);
  });

  v1.post('/budgets/:id/pause', requireRole('owner'), async (c) => {
    const actor = c.get('actor');
    const id = uuidParam(c.req.param('id'));
    const body = parse(PauseBudget, await readJsonBody(c.req.raw));
    const { key, requestHash } = idempotencyInput(c.req.header('idempotency-key'), { id, ...body });
    const result = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const claim = await claimOrReplay(tx, deps, actor, 'pauseBudget', key, requestHash);
      if (claim.replay) return claim.replay;
      await setBudgetPaused(tx, {
        budgetId: id,
        expectedVersion: body.expected_version,
        paused: body.paused,
      });
      const updated = await getBudget(tx, id);
      if (!updated) throw new ApiProblem('NOT_FOUND', 'No such cost limit in this workspace.');
      await insertAuditEvent(tx, {
        id: deps.newId(),
        actorSubject: actor.identity.subject,
        action: body.paused ? 'budget.paused' : 'budget.resumed',
        objectType: 'budget',
        objectId: id,
        objectVersion: updated.version,
        requestId: c.get('requestId'),
        detail: { reason: body.reason },
      });
      const budget = toBudget(updated);
      await completeIdempotencyKey(tx, { recordId: claim.recordId, responseStatus: 200, responseBody: budget });
      return { status: 200, body: budget };
    });
    return c.json(result.body as object, 200);
  });

  /* --------------------------------------------- operator-only extras */

  // Not in the M1 OpenAPI surface: read-only detail the workbench needs and the contract
  // covers only implicitly. Kept under a clearly separate prefix so the contract test can
  // tell intentional extras from drift.
  v1.get('/scans/:id/timeline', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const id = uuidParam(c.req.param('id'));
    const payload = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const scan = await getScan(tx, id);
      if (!scan) throw new ApiProblem('NOT_FOUND', 'No such scan in this workspace.');
      assertVenture(actor, scan.venture_id);
      const steps = await listScanSteps(tx, id);
      const evidence = await listEvidenceForScan(tx, id);
      const findings = await listFindingsForScan(tx, id);
      const projected = [];
      for (const finding of findings) {
        const links = await findingEvidenceIds(tx, finding.id);
        projected.push(toFinding(finding, links.supports, links.contradicts));
      }
      return {
        steps,
        evidence: evidence.map((e) =>
          toEvidence(e, Boolean(e.object_key) && deps.evidence.available && !e.redacted),
        ),
        findings: projected,
      };
    });
    return c.json(payload);
  });

  // The operator needs to know which purpose permission currently covers an account before
  // it can start a scan. Read-only, and it returns no purpose text or evidence note.
  v1.get('/accounts/:id/authorizations', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const accountId = uuidParam(c.req.param('id'));
    const items = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const account = await getAccount(tx, accountId);
      if (!account) throw new ApiProblem('NOT_FOUND', 'No such account in this workspace.');
      assertVenture(actor, account.venture_id);
      const rows = await listAuthorizations(tx, accountId);
      return rows.map(toAuthorization);
    });
    return c.json({ items, next_cursor: null });
  });

  v1.get('/findings/:id/reviews', requireRole('viewer'), async (c) => {
    const actor = c.get('actor');
    const id = uuidParam(c.req.param('id'));
    const rows = await deps.db.withTenant(actor.membership.tenantId, async (tx) => {
      const finding = await getFinding(tx, id);
      if (!finding) throw new ApiProblem('NOT_FOUND', 'No such finding in this workspace.');
      const scan = await getScan(tx, finding.scan_id);
      if (!scan) throw new ApiProblem('NOT_FOUND', 'No such finding in this workspace.');
      assertVenture(actor, scan.venture_id);
      return listReviews(tx, id);
    });
    return c.json({ items: rows, next_cursor: null });
  });

  app.route('/api/v1', v1);
  return app;
}

/* ----------------------------------------------------------- helpers */

function parse<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) {
    throw new ApiProblem('INVALID_REQUEST', describeZodError(result.error));
  }
  return result.data;
}

function describeZodError(error: unknown): string {
  const issues = (error as { issues?: { path: (string | number)[]; message: string }[] })?.issues;
  if (!issues?.length) return 'The request body does not match the contract.';
  const first = issues[0]!;
  const path = first.path.join('.') || '(body)';
  return `${path}: ${first.message}`;
}

function uuidParam(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiProblem('INVALID_REQUEST', 'Path identifier must be a UUID.');
  }
  return value;
}

function listParams(limitRaw: string | undefined, cursorRaw: string | undefined) {
  let limit = 25;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new ApiProblem('INVALID_REQUEST', 'limit must be an integer between 1 and 100.');
    }
    limit = parsed;
  }
  let cursor = null;
  if (cursorRaw !== undefined) {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) throw new ApiProblem('INVALID_REQUEST', 'cursor is not valid for this list.');
  }
  return { limit, cursor };
}

/**
 * Membership is checked again for every object, not only at list time.
 *
 * ROLES_PERMISSIONS.md: "Cross-tenant object lookups return the same not-found shape."
 * A venture the caller is not assigned to is a 403 within their own tenant, while another
 * tenant's object is already invisible through RLS and surfaces as 404.
 */
function assertVenture(actor: RequestActor, ventureId: string): void {
  if (!actor.membership.ventureIds.includes(ventureId)) {
    throw new ApiProblem('VENTURE_NOT_ASSIGNED', 'This membership is not assigned to that venture.');
  }
}

function transitionProblem(error: unknown, from: string, to: string, currentVersion: number): ApiProblem {
  if (error instanceof TransitionError) {
    if (error.code === 'VERSION_CONFLICT') {
      return new ApiProblem('VERSION_CONFLICT', `This record is now at version ${currentVersion}. Reload and retry.`);
    }
    return new ApiProblem('INVALID_TRANSITION', `A ${from} record cannot become ${to}.`);
  }
  return new ApiProblem('INVALID_REQUEST', 'The requested transition is not allowed.');
}

/** Shared idempotency claim used by every command route. */
async function claimOrReplay(
  tx: QueryExecutor,
  deps: AppDependencies,
  actor: RequestActor,
  operation: string,
  key: string,
  requestHash: string,
): Promise<{ recordId: string; replay: { status: number; body: unknown } | null }> {
  const { claimIdempotencyKey } = await import('@oe/db');
  const claim = await claimIdempotencyKey(tx, {
    id: deps.newId(),
    actorId: actor.membership.membershipId,
    operation,
    key,
    requestHash,
    expiresAt: new Date(deps.now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
  });
  if (claim.status === 'conflict') {
    throw new ApiProblem(
      'IDEMPOTENCY_CONFLICT',
      'This Idempotency-Key was already used with a different request. Use a new key.',
    );
  }
  if (claim.status === 'replay') {
    if (claim.responseStatus === null) {
      throw new ApiProblem(
        'IDEMPOTENCY_CONFLICT',
        'An earlier request with this Idempotency-Key has not finished. Retry in a moment.',
      );
    }
    return { recordId: claim.recordId, replay: { status: claim.responseStatus, body: claim.responseBody } };
  }
  return { recordId: claim.recordId, replay: null };
}

/** Scan projection including its cost snapshot, evidence and finding identifiers. */
async function projectScan(tx: QueryExecutor, deps: AppDependencies, row: ScanRow) {
  const scanRow = row;
  const budgets = await listBudgets(tx);
  const scanBudget = budgets.find((b) => b.scope_kind === 'scan' && b.scope_id === scanRow.id);
  const reservations = await tx.query<{ settlement_uncertain: boolean }>(
    `SELECT bool_or(state = 'uncertain') AS settlement_uncertain
       FROM oe.reservations WHERE scan_id = $1`,
    [scanRow.id],
  );
  const cost: ScanCostSnapshot = {
    currency: scanBudget?.currency ?? deps.config.ledgerCurrency,
    capMicro: scanBudget?.limit_micro ?? '0',
    settledMicro: scanBudget?.settled_micro ?? '0',
    reservedMicro: scanBudget?.reserved_micro ?? '0',
    settlementUncertain: Boolean(reservations.rows[0]?.settlement_uncertain),
  };
  const evidence = await listEvidenceForScan(tx, scanRow.id);
  const findings = await listFindingsForScan(tx, scanRow.id);
  return toScan(
    scanRow,
    cost,
    evidence.map((e) => e.id),
    findings.map((f) => f.id),
  );
}

export type { AppDependencies };
export { AccountSchema };
