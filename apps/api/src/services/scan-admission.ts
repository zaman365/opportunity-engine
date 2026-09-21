import { createHash } from 'node:crypto';
import type { CreateScan } from '@oe/contracts';
import {
  canonicalDetectorId,
  IMPLEMENTED_DETECTORS,
  isImplementedDetector,
  micro,
} from '@oe/domain';
import {
  claimIdempotencyKey,
  createBudget,
  ensureAsset,
  getAccount,
  getUsableAuthorization,
  insertAuditEvent,
  insertOutboxEvent,
  insertScan,
  LedgerError,
  reserveBudget,
  resolveScanBudgetIds,
  type QueryExecutor,
  type ScanRow,
} from '@oe/db';
import { ApiProblem } from '../problem.ts';
import type { AppDependencies, RequestActor } from '../context.ts';

/**
 * Scan admission: one transaction, one durable outcome.
 *
 * M1 §3: "Validate CreateScan request, CSRF, source policy, feature readiness, currency and
 * cap. Reserve each paid operation transactionally through the hierarchical ledger. Create
 * scan + outbox record atomically. Return 202 after commit."
 *
 * Nothing chargeable starts before this transaction commits, and a network timeout on the
 * client's side cannot produce a second scan: the idempotency claim is part of the same
 * transaction as the scan row.
 */

export interface AdmissionResult {
  scan: ScanRow;
  reservationId: string;
  /** Completed with the response body before the same transaction commits. */
  idempotencyRecordId: string;
  replayed: boolean;
  /** Present on a replay so the route can return the original response verbatim. */
  storedResponse: { status: number; body: unknown } | null;
}

/** Worst-case provider cost for one scan, in the tenant's ledger currency. */
export interface PriceSnapshot {
  currency: string;
  worstCaseMicro: string;
  source: string;
}

/**
 * Deterministic workflow instance ID.
 *
 * ADR-002: "Workflow instance IDs are deterministic from tenant + scan ID." The dispatcher
 * can therefore ask the provider whether an instance already exists before retrying a start
 * that timed out, instead of creating a second run.
 */
export function workflowInstanceId(tenantId: string, scanId: string): string {
  return createHash('sha256').update(`${tenantId}:${scanId}`).digest('hex').slice(0, 32);
}

export async function admitScan(
  tx: QueryExecutor,
  deps: AppDependencies,
  input: {
    actor: RequestActor;
    request: CreateScan;
    idempotencyKey: string;
    requestHash: string;
    requestId: string;
    price: PriceSnapshot;
  },
): Promise<AdmissionResult> {
  const { actor, request, price } = input;
  const nowIso = deps.now().toISOString();

  // 1 · Claim the operation. A replay short-circuits before any validation runs again.
  const claim = await claimIdempotencyKey(tx, {
    id: deps.newId(),
    actorId: actor.membership.membershipId,
    operation: 'createScan',
    key: input.idempotencyKey,
    requestHash: input.requestHash,
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
      // The original attempt is still in flight or crashed before completing. Repeating the
      // work now could admit a second scan, so the caller must retry.
      throw new ApiProblem(
        'IDEMPOTENCY_CONFLICT',
        'An earlier request with this Idempotency-Key has not finished. Retry in a moment.',
      );
    }
    return {
      scan: null as unknown as ScanRow,
      reservationId: '',
      idempotencyRecordId: claim.recordId,
      replayed: true,
      storedResponse: { status: claim.responseStatus, body: claim.responseBody },
    };
  }

  // 2 · Venture assignment, account, and the account's approved host policy.
  if (!actor.membership.ventureIds.includes(request.venture_id)) {
    throw new ApiProblem(
      'VENTURE_NOT_ASSIGNED',
      'This membership is not assigned to that venture.',
    );
  }
  const account = await getAccount(tx, request.account_id);
  if (!account) {
    throw new ApiProblem('NOT_FOUND', 'No such account in this workspace.');
  }
  if (account.venture_id !== request.venture_id) {
    throw new ApiProblem('INVALID_REQUEST', 'The account belongs to a different venture.');
  }

  // M1 §2: "Operator cannot expand the host policy." The allowlist comes from the account
  // row, never from the request.
  const preflight = deps.targetPolicy(request.target_url, account.approved_hosts);
  if (!preflight.allowed) {
    const code = preflight.reason === 'host_not_approved' ? 'TARGET_NOT_APPROVED' : 'UNSAFE_TARGET';
    throw new ApiProblem(code, targetDenialDetail(preflight.reason));
  }

  // 3 · Purpose permission, as a record with its own expiry and revocation.
  const authorization = await getUsableAuthorization(tx, {
    id: request.authorization_id,
    accountId: request.account_id,
    action: 'scan_public',
    now: nowIso,
  });
  if (authorization.reason === 'not_found') {
    throw new ApiProblem('NOT_FOUND', 'No such authorization for this account.');
  }
  if (authorization.reason === 'expired') {
    throw new ApiProblem(
      'AUTHORIZATION_EXPIRED',
      'The scan authorization expired. An owner must renew it.',
    );
  }
  if (authorization.reason === 'revoked') {
    throw new ApiProblem('AUTHORIZATION_REVOKED', 'The scan authorization was revoked.');
  }
  if (authorization.reason === 'action_mismatch') {
    throw new ApiProblem('INVALID_REQUEST', 'That authorization does not cover public scanning.');
  }

  // 4 · Detector phase and currency.
  //
  // Canonicalised on the way in, so what is stored on the scan — and later on every finding
  // and every audit row — is the engine's own id whichever spelling the caller used. The
  // request keeps whatever it sent; only what this system writes down is normalised.
  const requestedDetectors = request.detectors.map(
    (detector) => canonicalDetectorId(detector) ?? detector,
  );
  const unsupported = request.detectors.filter((detector) => !isImplementedDetector(detector));
  if (unsupported.length > 0) {
    throw new ApiProblem(
      'UNSUPPORTED_DETECTOR',
      `${unsupported.join(', ')} is specified but not implemented. This build runs ${IMPLEMENTED_DETECTORS.join(' and ')}.`,
    );
  }
  if (request.max_cost.currency !== actor.membership.ledgerCurrency) {
    throw new ApiProblem(
      'CURRENCY_MISMATCH',
      `This workspace accounts in ${actor.membership.ledgerCurrency}. No implicit conversion is performed.`,
    );
  }
  if (price.currency !== actor.membership.ledgerCurrency) {
    throw new ApiProblem(
      'CURRENCY_MISMATCH',
      'The provider price snapshot is in a different currency than the workspace ledger.',
    );
  }
  // The client's max_cost is an authorization ceiling, not a quote. If it cannot even cover
  // the worst case, the scan would be admitted only to stop halfway.
  if (micro(request.max_cost.amount_micro) < micro(price.worstCaseMicro)) {
    throw new ApiProblem(
      'BUDGET_EXCEEDED',
      'The scan limit is below the worst-case provider cost for this scope.',
    );
  }

  // 5 · Durable rows. Scan, its own scan-scoped cap, then the hierarchical reservation.
  const scanId = deps.newId();
  const scan = await insertScan(tx, {
    id: scanId,
    accountId: request.account_id,
    ventureId: request.venture_id,
    authorizationId: request.authorization_id,
    targetUrl: preflight.url,
    expectedUniquePages: request.max_unique_pages,
    detectors: requestedDetectors,
    requestedBy: actor.membership.membershipId,
    workflowInstanceId: workflowInstanceId(actor.membership.tenantId, scanId),
  });

  await ensureAsset(tx, {
    id: deps.newId(),
    accountId: request.account_id,
    canonicalUrl: preflight.url,
  });

  await createBudget(tx, {
    id: deps.newId(),
    scopeKind: 'scan',
    scopeId: scanId,
    currency: request.max_cost.currency,
    limitMicro: request.max_cost.amount_micro,
    paused: false,
  });

  const scopes = await resolveScanBudgetIds(tx, {
    tenantId: actor.membership.tenantId,
    ventureId: request.venture_id,
    scanId,
  });
  if (scopes.missing.length > 0) {
    throw new ApiProblem(
      'PROVIDER_NOT_CONFIGURED',
      `No ${scopes.missing.join(' or ')} cost limit is configured. An owner must set one before scans can run.`,
    );
  }

  let reservationId: string;
  try {
    const reservation = await reserveBudget(tx, {
      scanId,
      operationKey: `scan:${scanId}:capture`,
      requestHash: input.requestHash,
      currency: price.currency,
      amountMicro: price.worstCaseMicro,
      budgetIds: scopes.ids,
    });
    reservationId = reservation.reservationId;
  } catch (error) {
    if (error instanceof LedgerError) throw ledgerProblem(error);
    throw error;
  }

  // 6 · The outbox row shares this transaction, which is what closes the dual-write gap
  // between "scan exists" and "work was scheduled" (ADR-002).
  await insertOutboxEvent(tx, {
    id: deps.newId(),
    aggregateId: scanId,
    aggregateType: 'scan',
    aggregateVersion: scan.version,
    eventType: 'scan.admitted',
    payload: {
      scan_id: scanId,
      workflow_instance_id: scan.workflow_instance_id,
      target_url: preflight.url,
      max_unique_pages: request.max_unique_pages,
      detectors: requestedDetectors,
      approved_hosts: account.approved_hosts,
      operation_key: `scan:${scanId}:capture`,
    },
  });

  await insertAuditEvent(tx, {
    id: deps.newId(),
    actorSubject: actor.identity.subject,
    action: 'scan.admitted',
    objectType: 'scan',
    objectId: scanId,
    objectVersion: scan.version,
    requestId: input.requestId,
    detail: {
      account_id: request.account_id,
      authorization_id: request.authorization_id,
      policy_version: authorization.row?.policy_version ?? null,
      // Host only: SECURITY.md requires logging in redacted form.
      target_host: preflight.host,
      max_unique_pages: request.max_unique_pages,
      reserved_micro: price.worstCaseMicro,
      price_source: price.source,
    },
  });

  return {
    scan,
    reservationId,
    idempotencyRecordId: claim.recordId,
    replayed: false,
    storedResponse: null,
  };
}

export function ledgerProblem(error: LedgerError): ApiProblem {
  switch (error.code) {
    case 'BUDGET_EXCEEDED':
      return new ApiProblem(
        'BUDGET_EXCEEDED',
        'This operation would exceed a cost limit. Raise the limit or wait for in-flight work to settle.',
      );
    case 'BUDGET_PAUSED':
      return new ApiProblem(
        'BUDGET_PAUSED',
        'A cost limit covering this work is paused. An owner must resume it with a recorded reason.',
      );
    case 'CURRENCY_MISMATCH':
      return new ApiProblem('CURRENCY_MISMATCH', 'The cost limit uses a different currency.');
    case 'IDEMPOTENCY_CONFLICT':
      return new ApiProblem(
        'IDEMPOTENCY_CONFLICT',
        'The same operation key was reused with different cost input.',
      );
    case 'VERSION_CONFLICT':
      return new ApiProblem(
        'VERSION_CONFLICT',
        'The cost limit changed since it was read. Reload and retry.',
      );
    case 'OVERRUN_NOT_RECONCILED':
      return new ApiProblem(
        'BUDGET_PAUSED',
        'Committed spend still exceeds this limit. Reconcile the overrun before resuming.',
      );
    case 'LIMIT_BELOW_COMMITTED':
      return new ApiProblem(
        'INVALID_REQUEST',
        'A limit cannot be set below the amount already settled and reserved.',
      );
    case 'UNKNOWN_BUDGET':
    case 'UNKNOWN_RESERVATION':
      return new ApiProblem('NOT_FOUND', 'No such cost record in this workspace.');
    case 'RECONCILIATION_REQUIRED':
      return new ApiProblem(
        'INVALID_REQUEST',
        'Releasing a reservation requires confirmation that no provider charge was incurred.',
      );
    default:
      return new ApiProblem('DEPENDENCY_UNAVAILABLE', 'The cost ledger rejected this operation.');
  }
}

function targetDenialDetail(reason: string): string {
  switch (reason) {
    case 'host_not_approved':
      return 'That host is not on this account’s approved list. An owner must approve it first.';
    case 'https_required':
      return 'Only https targets can be inspected.';
    case 'potential_state_change':
      return 'That path looks like it could change store state, so it is never navigated.';
    case 'sensitive_query':
      return 'The URL carries a token-like query parameter and was rejected.';
    case 'ip_literal_denied':
    case 'nonpublic_hostname':
      return 'Only public hostnames can be inspected.';
    case 'embedded_credentials':
      return 'URLs with embedded credentials are rejected.';
    case 'unsupported_port':
      return 'Only the default https port is allowed.';
    default:
      return 'The target failed the capture safety policy.';
  }
}
