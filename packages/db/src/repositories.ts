import type { QueryExecutor } from './client.ts';

/**
 * Tenant-scoped data access.
 *
 * Every function takes a `QueryExecutor` that is already inside a transaction with the
 * tenant context set (see `Database.withTenant`). None of them accept a tenant_id argument:
 * the boundary is the transaction setting plus RLS, never a value a caller passes in.
 */

export interface MembershipRecord {
  tenantId: string;
  membershipId: string;
  role: 'viewer' | 'operator' | 'reviewer' | 'owner';
  ventureIds: string[];
  /** Filled in by {@link getLedgerCurrency} once a tenant context exists. */
  ledgerCurrency: string;
}

/**
 * Resolve a verified `(issuer, subject)` to active memberships.
 *
 * Runs on the identity connection with no tenant context, because the tenant is the
 * answer rather than an input. ROLES_PERMISSIONS.md keeps this role's reads to exactly
 * memberships and member_ventures.
 */
export async function resolveMemberships(
  tx: QueryExecutor,
  issuer: string,
  subject: string,
): Promise<MembershipRecord[]> {
  const result = await tx.query<{
    tenant_id: string;
    membership_id: string;
    role: MembershipRecord['role'];
    venture_ids: string[] | null;
  }>(
    `SELECT m.tenant_id,
            m.id AS membership_id,
            m.role,
            coalesce(array_agg(mv.venture_id) FILTER (WHERE mv.venture_id IS NOT NULL), '{}') AS venture_ids
       FROM oe.memberships m
       LEFT JOIN oe.member_ventures mv
         ON mv.tenant_id = m.tenant_id AND mv.membership_id = m.id
      WHERE m.issuer = $1 AND m.subject = $2 AND m.active
      GROUP BY m.tenant_id, m.id, m.role
      ORDER BY m.tenant_id`,
    [issuer, subject],
  );
  return result.rows.map((row) => ({
    tenantId: row.tenant_id,
    membershipId: row.membership_id,
    role: row.role,
    ventureIds: row.venture_ids ?? [],
    // The identity role deliberately cannot read oe.tenants. The accounting currency is
    // read on the runtime connection once the tenant context exists.
    ledgerCurrency: '',
  }));
}

/** Read the tenant's accounting currency. Requires an established tenant context. */
export async function getLedgerCurrency(tx: QueryExecutor): Promise<string | null> {
  const result = await tx.query<{ ledger_currency: string }>(
    'SELECT ledger_currency FROM oe.tenants WHERE id = oe.tenant_context()',
  );
  return result.rows[0]?.ledger_currency ?? null;
}

/* ------------------------------------------------------------------ accounts */

export interface AccountRow {
  id: string;
  name: string;
  canonical_domain: string;
  venture_id: string;
  approved_hosts: string[];
  version: number;
  created_at: string;
}

const ACCOUNT_COLUMNS =
  'id, name, canonical_domain, venture_id, approved_hosts, version, to_char(created_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') AS created_at';

export async function insertAccount(
  tx: QueryExecutor,
  input: {
    id: string;
    ventureId: string;
    name: string;
    canonicalDomain: string;
    approvedHosts: string[];
    sourceNote: string;
  },
): Promise<AccountRow> {
  const result = await tx.query<AccountRow>(
    `INSERT INTO oe.accounts
       (tenant_id, id, venture_id, name, canonical_domain, approved_hosts, source_note)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, $6)
     RETURNING ${ACCOUNT_COLUMNS}`,
    [
      input.id,
      input.ventureId,
      input.name,
      input.canonicalDomain,
      input.approvedHosts,
      input.sourceNote,
    ],
  );
  return result.rows[0]!;
}

export async function listAccounts(
  tx: QueryExecutor,
  input: { ventureIds: string[]; limit: number; cursor: { createdAt: string; id: string } | null },
): Promise<AccountRow[]> {
  const params: unknown[] = [input.ventureIds, input.limit + 1];
  let keyset = '';
  if (input.cursor) {
    params.push(input.cursor.createdAt, input.cursor.id);
    keyset = ' AND (created_at, id) < ($3::timestamptz, $4::uuid)';
  }
  const result = await tx.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM oe.accounts
      WHERE venture_id = ANY($1::uuid[])${keyset}
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    params,
  );
  return result.rows;
}

export async function getAccount(tx: QueryExecutor, id: string): Promise<AccountRow | null> {
  const result = await tx.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM oe.accounts WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/* ------------------------------------------------------- authorizations */

export interface AuthorizationRow {
  id: string;
  account_id: string;
  action: 'scan_public' | 'publish_internal_report';
  expires_at: string;
  revoked_at: string | null;
  policy_version: string;
}

const AUTHORIZATION_COLUMNS = `id, account_id, action,
  to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at,
  to_char(revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS revoked_at,
  policy_version`;

export async function insertAuthorization(
  tx: QueryExecutor,
  input: {
    id: string;
    accountId: string;
    action: 'scan_public' | 'publish_internal_report';
    purpose: string;
    evidenceNote: string;
    policyVersion: string;
    grantedBy: string;
    expiresAt: string;
  },
): Promise<AuthorizationRow> {
  const result = await tx.query<AuthorizationRow>(
    `INSERT INTO oe.authorizations
       (tenant_id, id, account_id, action, purpose, evidence_note, policy_version, granted_by, expires_at)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
     RETURNING ${AUTHORIZATION_COLUMNS}`,
    [
      input.id,
      input.accountId,
      input.action,
      input.purpose,
      input.evidenceNote,
      input.policyVersion,
      input.grantedBy,
      input.expiresAt,
    ],
  );
  return result.rows[0]!;
}

/**
 * Fetch an authorization only when it is currently usable for `action` on `accountId`.
 * Unknown, expired or revoked is deny — the caller receives null and must say which.
 */
export async function getUsableAuthorization(
  tx: QueryExecutor,
  input: { id: string; accountId: string; action: string; now: string },
): Promise<{
  row: AuthorizationRow | null;
  reason: 'ok' | 'not_found' | 'expired' | 'revoked' | 'action_mismatch';
}> {
  const result = await tx.query<AuthorizationRow & { expired: boolean }>(
    `SELECT ${AUTHORIZATION_COLUMNS}, (expires_at <= $3::timestamptz) AS expired
       FROM oe.authorizations WHERE id = $1 AND account_id = $2`,
    [input.id, input.accountId, input.now],
  );
  const row = result.rows[0];
  if (!row) return { row: null, reason: 'not_found' };
  if (row.revoked_at !== null) return { row: null, reason: 'revoked' };
  if (row.expired) return { row: null, reason: 'expired' };
  if (row.action !== input.action) return { row: null, reason: 'action_mismatch' };
  return { row, reason: 'ok' };
}

/** Current authorization records for one account, newest first. */
export async function listAuthorizations(
  tx: QueryExecutor,
  accountId: string,
): Promise<AuthorizationRow[]> {
  const result = await tx.query<AuthorizationRow>(
    `SELECT ${AUTHORIZATION_COLUMNS} FROM oe.authorizations
      WHERE account_id = $1 ORDER BY granted_at DESC`,
    [accountId],
  );
  return result.rows;
}

/* --------------------------------------------------------------- assets */

export async function ensureAsset(
  tx: QueryExecutor,
  input: { id: string; accountId: string; canonicalUrl: string },
): Promise<string> {
  // Assets are immutable once recorded, so the runtime holds no UPDATE grant on them:
  // a conflict means the asset already exists and its existing id is the answer.
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO oe.assets (tenant_id, id, account_id, canonical_url)
     VALUES (oe.tenant_context(), $1, $2, $3)
     ON CONFLICT (tenant_id, account_id, canonical_url) DO NOTHING
     RETURNING id`,
    [input.id, input.accountId, input.canonicalUrl],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await tx.query<{ id: string }>(
    'SELECT id FROM oe.assets WHERE account_id = $1 AND canonical_url = $2',
    [input.accountId, input.canonicalUrl],
  );
  if (!existing.rows[0]) throw new Error('Asset row vanished between insert and read.');
  return existing.rows[0].id;
}

/* ---------------------------------------------------------------- scans */

export interface ScanRow {
  id: string;
  account_id: string;
  venture_id: string;
  authorization_id: string;
  state: string;
  version: number;
  target_url: string;
  expected_unique_pages: number;
  captured_unique_pages: number;
  reasons: string[];
  detectors: string[];
  workflow_instance_id: string | null;
  supersedes_scan_id: string | null;
  created_at: string;
  updated_at: string;
}

const SCAN_COLUMNS = `id, account_id, venture_id, authorization_id, state, version, target_url,
  expected_unique_pages, captured_unique_pages, reasons, detectors, workflow_instance_id, supersedes_scan_id,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`;

export async function insertScan(
  tx: QueryExecutor,
  input: {
    id: string;
    accountId: string;
    ventureId: string;
    authorizationId: string;
    targetUrl: string;
    expectedUniquePages: number;
    detectors: string[];
    requestedBy: string;
    workflowInstanceId: string;
  },
): Promise<ScanRow> {
  const result = await tx.query<ScanRow>(
    `INSERT INTO oe.scans
       (tenant_id, id, account_id, venture_id, authorization_id, target_url, state, version,
        expected_unique_pages, detectors, requested_by, workflow_instance_id)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, 'queued', 1, $6, $7, $8, $9)
     RETURNING ${SCAN_COLUMNS}`,
    [
      input.id,
      input.accountId,
      input.ventureId,
      input.authorizationId,
      input.targetUrl,
      input.expectedUniquePages,
      input.detectors,
      input.requestedBy,
      input.workflowInstanceId,
    ],
  );
  return result.rows[0]!;
}

export async function getScan(tx: QueryExecutor, id: string): Promise<ScanRow | null> {
  const result = await tx.query<ScanRow>(`SELECT ${SCAN_COLUMNS} FROM oe.scans WHERE id = $1`, [
    id,
  ]);
  return result.rows[0] ?? null;
}

export async function listScans(
  tx: QueryExecutor,
  input: { ventureIds: string[]; limit: number; cursor: { createdAt: string; id: string } | null },
): Promise<ScanRow[]> {
  const params: unknown[] = [input.ventureIds, input.limit + 1];
  let keyset = '';
  if (input.cursor) {
    params.push(input.cursor.createdAt, input.cursor.id);
    keyset = ' AND (created_at, id) < ($3::timestamptz, $4::uuid)';
  }
  const result = await tx.query<ScanRow>(
    `SELECT ${SCAN_COLUMNS} FROM oe.scans
      WHERE venture_id = ANY($1::uuid[])${keyset}
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    params,
  );
  return result.rows;
}

/**
 * Compare-and-swap scan state. Returns null when the expected version no longer matches,
 * which the caller reports as a conflict rather than retrying blindly.
 */
export async function advanceScan(
  tx: QueryExecutor,
  input: {
    id: string;
    expectedVersion: number;
    nextState: string;
    capturedUniquePages?: number;
    reasons?: string[];
    cancelRequestedAt?: string;
  },
): Promise<ScanRow | null> {
  const result = await tx.query<ScanRow>(
    `UPDATE oe.scans
        SET state = $3,
            version = version + 1,
            captured_unique_pages = COALESCE($4::integer, captured_unique_pages),
            reasons = COALESCE($5::jsonb, reasons),
            cancel_requested_at = COALESCE($6::timestamptz, cancel_requested_at),
            updated_at = now()
      WHERE id = $1 AND version = $2
      RETURNING ${SCAN_COLUMNS}`,
    [
      input.id,
      input.expectedVersion,
      input.nextState,
      input.capturedUniquePages ?? null,
      input.reasons ? JSON.stringify(input.reasons) : null,
      input.cancelRequestedAt ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

export async function upsertScanStep(
  tx: QueryExecutor,
  input: {
    id: string;
    scanId: string;
    stepKey: string;
    state: string;
    attempt: number;
    providerRequestId?: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO oe.scan_steps (tenant_id, id, scan_id, step_key, state, attempt, provider_request_id)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, scan_id, step_key) DO UPDATE
       SET state = EXCLUDED.state,
           attempt = EXCLUDED.attempt,
           provider_request_id = COALESCE(EXCLUDED.provider_request_id, oe.scan_steps.provider_request_id),
           updated_at = now()`,
    [
      input.id,
      input.scanId,
      input.stepKey,
      input.state,
      input.attempt,
      input.providerRequestId ?? null,
    ],
  );
}

export interface ScanStepRow {
  id: string;
  step_key: string;
  state: string;
  attempt: number;
  provider_request_id: string | null;
  updated_at: string;
}

export async function listScanSteps(tx: QueryExecutor, scanId: string): Promise<ScanStepRow[]> {
  const result = await tx.query<ScanStepRow>(
    `SELECT id, step_key, state, attempt, provider_request_id,
            to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
       FROM oe.scan_steps WHERE scan_id = $1 ORDER BY updated_at, step_key`,
    [scanId],
  );
  return result.rows;
}

/* ------------------------------------------------------------- evidence */

export interface EvidenceRow {
  id: string;
  scan_id: string;
  asset_id: string;
  kind: 'screenshot' | 'http_observation' | 'dom_observation';
  source_url: string;
  final_url: string;
  object_key: string | null;
  sha256: string;
  conditions: Record<string, unknown>;
  observation: Record<string, unknown>;
  http_status: number | null;
  complete: boolean;
  redacted: boolean;
  capture_role: 'source_page' | 'link_destination' | 'product_image';
  session_ordinal: number;
  context_key: string;
  captured_at: string;
  expires_at: string;
}

const EVIDENCE_COLUMNS = `id, scan_id, asset_id, kind, source_url, final_url, object_key, sha256,
  conditions, observation, http_status, complete, redacted, capture_role, session_ordinal, context_key,
  to_char(captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at,
  to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at`;

export async function insertEvidence(
  tx: QueryExecutor,
  input: {
    id: string;
    scanId: string;
    assetId: string;
    kind: EvidenceRow['kind'];
    sourceUrl: string;
    finalUrl: string;
    objectKey: string | null;
    sha256: string;
    conditions: Record<string, unknown>;
    observation: Record<string, unknown>;
    httpStatus: number | null;
    complete: boolean;
    captureRole: EvidenceRow['capture_role'];
    sessionOrdinal: number;
    contextKey: string;
    capturedAt: string;
    expiresAt: string;
  },
): Promise<EvidenceRow> {
  const result = await tx.query<EvidenceRow>(
    `INSERT INTO oe.evidence
       (tenant_id, id, scan_id, asset_id, kind, source_url, final_url, object_key, sha256,
        conditions, observation, http_status, complete, capture_role, session_ordinal, context_key,
        captured_at, expires_at)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12,
             $13, $14, $15, $16::timestamptz, $17::timestamptz)
     RETURNING ${EVIDENCE_COLUMNS}`,
    [
      input.id,
      input.scanId,
      input.assetId,
      input.kind,
      input.sourceUrl,
      input.finalUrl,
      input.objectKey,
      input.sha256,
      JSON.stringify(input.conditions),
      JSON.stringify(input.observation),
      input.httpStatus,
      input.complete,
      input.captureRole,
      input.sessionOrdinal,
      input.contextKey,
      input.capturedAt,
      input.expiresAt,
    ],
  );
  return result.rows[0]!;
}

export async function listEvidenceForScan(
  tx: QueryExecutor,
  scanId: string,
): Promise<EvidenceRow[]> {
  const result = await tx.query<EvidenceRow>(
    `SELECT ${EVIDENCE_COLUMNS} FROM oe.evidence WHERE scan_id = $1
      ORDER BY capture_role, session_ordinal, captured_at`,
    [scanId],
  );
  return result.rows;
}

export async function getEvidence(tx: QueryExecutor, id: string): Promise<EvidenceRow | null> {
  const result = await tx.query<EvidenceRow>(
    `SELECT ${EVIDENCE_COLUMNS} FROM oe.evidence WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listEvidenceByIds(tx: QueryExecutor, ids: string[]): Promise<EvidenceRow[]> {
  if (ids.length === 0) return [];
  const result = await tx.query<EvidenceRow>(
    `SELECT ${EVIDENCE_COLUMNS} FROM oe.evidence WHERE id = ANY($1::uuid[])
      ORDER BY capture_role, session_ordinal, captured_at`,
    [ids],
  );
  return result.rows;
}

/* -------------------------------------------------------------- findings */

export interface FindingRow {
  id: string;
  scan_id: string;
  asset_id: string;
  detector_id: string;
  detector_version: string;
  state: string;
  version: number;
  root_cause_key: string;
  claim: string;
  scope: string;
  limitations: string[];
  evidence_grade: 'A' | 'B' | 'C' | null;
  commercial_impact: string;
  reviewer_id: string | null;
  reviewed_at: string | null;
  captured_at: string;
  target_url: string | null;
  detector_output: Record<string, unknown>;
  evidence_fresh_until: string | null;
}

const FINDING_COLUMNS = `id, scan_id, asset_id, detector_id, detector_version, state, version,
  root_cause_key, claim, scope, limitations, evidence_grade, commercial_impact, reviewer_id,
  target_url, detector_output,
  to_char(reviewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at,
  to_char(captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at,
  to_char(evidence_fresh_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS evidence_fresh_until`;

export async function insertFinding(
  tx: QueryExecutor,
  input: {
    id: string;
    scanId: string;
    assetId: string;
    detectorId: string;
    detectorVersion: string;
    state: 'candidate' | 'unknown';
    rootCauseKey: string;
    claim: string;
    scope: string;
    limitations: string[];
    evidenceGrade: 'A' | 'B' | 'C' | null;
    capturedAt: string;
    targetUrl: string;
    detectorOutput: Record<string, unknown>;
    evidenceFreshUntil: string;
  },
): Promise<FindingRow> {
  const result = await tx.query<FindingRow>(
    `INSERT INTO oe.findings
       (tenant_id, id, scan_id, asset_id, detector_id, detector_version, state, version,
        root_cause_key, claim, scope, limitations, evidence_grade, commercial_impact,
        captured_at, target_url, detector_output, evidence_fresh_until)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10::jsonb, $11,
             'hypothesis', $12::timestamptz, $13, $14::jsonb, $15::timestamptz)
     RETURNING ${FINDING_COLUMNS}`,
    [
      input.id,
      input.scanId,
      input.assetId,
      input.detectorId,
      input.detectorVersion,
      input.state,
      input.rootCauseKey,
      input.claim,
      input.scope,
      JSON.stringify(input.limitations),
      input.evidenceGrade,
      input.capturedAt,
      input.targetUrl,
      JSON.stringify(input.detectorOutput),
      input.evidenceFreshUntil,
    ],
  );
  return result.rows[0]!;
}

export async function linkFindingEvidence(
  tx: QueryExecutor,
  input: {
    id: string;
    findingId: string;
    evidenceId: string;
    relationship: 'supports' | 'contradicts';
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO oe.finding_evidence (tenant_id, id, finding_id, evidence_id, relationship)
     VALUES (oe.tenant_context(), $1, $2, $3, $4)
     ON CONFLICT (tenant_id, finding_id, evidence_id, relationship) DO NOTHING`,
    [input.id, input.findingId, input.evidenceId, input.relationship],
  );
}

export async function getFinding(tx: QueryExecutor, id: string): Promise<FindingRow | null> {
  const result = await tx.query<FindingRow>(
    `SELECT ${FINDING_COLUMNS} FROM oe.findings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listFindingsForScan(
  tx: QueryExecutor,
  scanId: string,
): Promise<FindingRow[]> {
  const result = await tx.query<FindingRow>(
    `SELECT ${FINDING_COLUMNS} FROM oe.findings WHERE scan_id = $1 ORDER BY captured_at, id`,
    [scanId],
  );
  return result.rows;
}

export async function findingEvidenceIds(
  tx: QueryExecutor,
  findingId: string,
): Promise<{ supports: string[]; contradicts: string[] }> {
  const result = await tx.query<{ evidence_id: string; relationship: string }>(
    'SELECT evidence_id, relationship FROM oe.finding_evidence WHERE finding_id = $1 ORDER BY evidence_id',
    [findingId],
  );
  return {
    supports: result.rows.filter((r) => r.relationship === 'supports').map((r) => r.evidence_id),
    contradicts: result.rows
      .filter((r) => r.relationship === 'contradicts')
      .map((r) => r.evidence_id),
  };
}

/** Compare-and-swap finding review. Null means the version moved under the reviewer. */
export async function applyFindingReview(
  tx: QueryExecutor,
  input: {
    findingId: string;
    expectedVersion: number;
    nextState: 'confirmed' | 'rejected' | 'unknown' | 'stale';
    reviewerId: string | null;
    reviewedAt: string | null;
  },
): Promise<FindingRow | null> {
  const result = await tx.query<FindingRow>(
    `UPDATE oe.findings
        SET state = $3,
            version = version + 1,
            reviewer_id = $4,
            reviewed_at = $5::timestamptz
      WHERE id = $1 AND version = $2
      RETURNING ${FINDING_COLUMNS}`,
    [input.findingId, input.expectedVersion, input.nextState, input.reviewerId, input.reviewedAt],
  );
  return result.rows[0] ?? null;
}

export async function insertReview(
  tx: QueryExecutor,
  input: {
    id: string;
    findingId: string;
    findingVersion: number;
    reviewerId: string;
    decision: 'confirm' | 'reject' | 'unknown';
    reason: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO oe.reviews (tenant_id, id, finding_id, finding_version, reviewer_id, decision, reason)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.findingId,
      input.findingVersion,
      input.reviewerId,
      input.decision,
      input.reason,
    ],
  );
}

export interface ReviewRow {
  id: string;
  finding_id: string;
  finding_version: number;
  reviewer_id: string;
  decision: string;
  reason: string;
  created_at: string;
}

export async function listReviews(tx: QueryExecutor, findingId: string): Promise<ReviewRow[]> {
  const result = await tx.query<ReviewRow>(
    `SELECT id, finding_id, finding_version, reviewer_id, decision, reason,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM oe.reviews WHERE finding_id = $1 ORDER BY created_at DESC`,
    [findingId],
  );
  return result.rows;
}

/* --------------------------------------------------------- opportunities */

export interface OpportunityRow {
  id: string;
  account_id: string;
  venture_id: string;
  title: string;
  priority: Record<string, unknown> | null;
  owner_id: string | null;
  permission_state: string;
  next_action: string;
  updated_at: string;
}

const OPPORTUNITY_COLUMNS = `id, account_id, venture_id, title, priority, owner_id, permission_state, next_action,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`;

/** Same projection, qualified for the joined queries below. */
const OPPORTUNITY_COLUMNS_O = `o.id, o.account_id, o.venture_id, o.title, o.priority, o.owner_id,
  o.permission_state, o.next_action,
  to_char(o.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`;

export async function insertOpportunity(
  tx: QueryExecutor,
  input: {
    id: string;
    accountId: string;
    ventureId: string;
    title: string;
    priority: Record<string, unknown> | null;
    permissionState: string;
    nextAction: string;
    ownerId: string | null;
  },
): Promise<OpportunityRow> {
  const result = await tx.query<OpportunityRow>(
    `INSERT INTO oe.opportunities
       (tenant_id, id, account_id, venture_id, title, priority, permission_state, next_action, owner_id)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     RETURNING ${OPPORTUNITY_COLUMNS}`,
    [
      input.id,
      input.accountId,
      input.ventureId,
      input.title,
      input.priority ? JSON.stringify(input.priority) : null,
      input.permissionState,
      input.nextAction,
      input.ownerId,
    ],
  );
  return result.rows[0]!;
}

export async function updateOpportunity(
  tx: QueryExecutor,
  input: {
    id: string;
    title?: string;
    priority?: Record<string, unknown> | null;
    permissionState?: string;
    nextAction?: string;
  },
): Promise<OpportunityRow | null> {
  const result = await tx.query<OpportunityRow>(
    `UPDATE oe.opportunities
        SET title = COALESCE($2, title),
            priority = COALESCE($3::jsonb, priority),
            permission_state = COALESCE($4, permission_state),
            next_action = COALESCE($5, next_action),
            updated_at = now()
      WHERE id = $1
      RETURNING ${OPPORTUNITY_COLUMNS}`,
    [
      input.id,
      input.title ?? null,
      input.priority === undefined || input.priority === null
        ? null
        : JSON.stringify(input.priority),
      input.permissionState ?? null,
      input.nextAction ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

export async function linkOpportunityFinding(
  tx: QueryExecutor,
  input: { id: string; opportunityId: string; findingId: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO oe.opportunity_findings (tenant_id, id, opportunity_id, finding_id)
     VALUES (oe.tenant_context(), $1, $2, $3)
     ON CONFLICT (tenant_id, opportunity_id, finding_id) DO NOTHING`,
    [input.id, input.opportunityId, input.findingId],
  );
}

export async function listOpportunities(
  tx: QueryExecutor,
  input: { ventureIds: string[]; limit: number; cursor: { updatedAt: string; id: string } | null },
): Promise<(OpportunityRow & { finding_ids: string[] })[]> {
  const params: unknown[] = [input.ventureIds, input.limit + 1];
  let keyset = '';
  if (input.cursor) {
    params.push(input.cursor.updatedAt, input.cursor.id);
    keyset = ' AND (o.updated_at, o.id) < ($3::timestamptz, $4::uuid)';
  }
  const result = await tx.query<OpportunityRow & { finding_ids: string[] | null }>(
    `SELECT ${OPPORTUNITY_COLUMNS_O},
            coalesce(array_agg(f.finding_id) FILTER (WHERE f.finding_id IS NOT NULL), '{}') AS finding_ids
       FROM oe.opportunities o
       LEFT JOIN oe.opportunity_findings f ON f.tenant_id = o.tenant_id AND f.opportunity_id = o.id
      WHERE o.venture_id = ANY($1::uuid[])${keyset}
      GROUP BY o.id, o.account_id, o.venture_id, o.title, o.priority, o.owner_id,
               o.permission_state, o.next_action, o.updated_at
      ORDER BY o.updated_at DESC, o.id DESC
      LIMIT $2`,
    params,
  );
  return result.rows.map((row) => ({ ...row, finding_ids: row.finding_ids ?? [] }));
}

export async function getOpportunity(
  tx: QueryExecutor,
  id: string,
): Promise<(OpportunityRow & { finding_ids: string[] }) | null> {
  const result = await tx.query<OpportunityRow>(
    `SELECT ${OPPORTUNITY_COLUMNS} FROM oe.opportunities WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const links = await tx.query<{ finding_id: string }>(
    'SELECT finding_id FROM oe.opportunity_findings WHERE opportunity_id = $1 ORDER BY finding_id',
    [id],
  );
  return { ...row, finding_ids: links.rows.map((r) => r.finding_id) };
}

export async function findOpportunityByAccountAndRootCause(
  tx: QueryExecutor,
  input: { accountId: string; rootCauseKey: string },
): Promise<OpportunityRow | null> {
  const result = await tx.query<OpportunityRow>(
    `SELECT DISTINCT ${OPPORTUNITY_COLUMNS_O}
       FROM oe.opportunities o
       JOIN oe.opportunity_findings l ON l.tenant_id = o.tenant_id AND l.opportunity_id = o.id
       JOIN oe.findings f ON f.tenant_id = o.tenant_id AND f.id = l.finding_id
      WHERE o.account_id = $1 AND f.root_cause_key = $2
      LIMIT 1`,
    [input.accountId, input.rootCauseKey],
  );
  return result.rows[0] ?? null;
}

/* --------------------------------------------------------------- reports */

export interface ReportRow {
  id: string;
  account_id: string;
  scan_id: string;
  state: string;
  version: number;
  language: 'en' | 'de';
  audience: string;
  snapshot: Record<string, unknown>;
  body: Record<string, unknown> | null;
  body_sha256: string | null;
  created_at: string;
  approved_at: string | null;
  published_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

const REPORT_COLUMNS = `id, account_id, scan_id, state, version, language, audience, snapshot, body, body_sha256, revoke_reason,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char(approved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS approved_at,
  to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS published_at,
  to_char(revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS revoked_at`;

export async function insertReport(
  tx: QueryExecutor,
  input: {
    id: string;
    accountId: string;
    scanId: string;
    language: 'en' | 'de';
    snapshot: Record<string, unknown>;
    body: Record<string, unknown>;
    bodySha256: string;
  },
): Promise<ReportRow> {
  const result = await tx.query<ReportRow>(
    `INSERT INTO oe.reports
       (tenant_id, id, account_id, scan_id, state, version, language, snapshot, body, body_sha256)
     VALUES (oe.tenant_context(), $1, $2, $3, 'draft', 1, $4, $5::jsonb, $6::jsonb, $7)
     RETURNING ${REPORT_COLUMNS}`,
    [
      input.id,
      input.accountId,
      input.scanId,
      input.language,
      JSON.stringify(input.snapshot),
      JSON.stringify(input.body),
      input.bodySha256,
    ],
  );
  return result.rows[0]!;
}

export async function linkReportFinding(
  tx: QueryExecutor,
  input: { id: string; reportId: string; findingId: string; findingVersion: number },
): Promise<void> {
  await tx.query(
    `INSERT INTO oe.report_findings (tenant_id, id, report_id, finding_id, finding_version)
     VALUES (oe.tenant_context(), $1, $2, $3, $4)`,
    [input.id, input.reportId, input.findingId, input.findingVersion],
  );
}

export async function listReportFindings(
  tx: QueryExecutor,
  reportId: string,
): Promise<{ finding_id: string; finding_version: number }[]> {
  const result = await tx.query<{ finding_id: string; finding_version: number }>(
    'SELECT finding_id, finding_version FROM oe.report_findings WHERE report_id = $1 ORDER BY finding_id',
    [reportId],
  );
  return result.rows;
}

export async function getReport(tx: QueryExecutor, id: string): Promise<ReportRow | null> {
  const result = await tx.query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM oe.reports WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listReportsForScan(tx: QueryExecutor, scanId: string): Promise<ReportRow[]> {
  const result = await tx.query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM oe.reports WHERE scan_id = $1 ORDER BY created_at DESC`,
    [scanId],
  );
  return result.rows;
}

export async function advanceReport(
  tx: QueryExecutor,
  input: {
    id: string;
    expectedVersion: number;
    nextState: 'approved' | 'published' | 'revoked' | 'superseded';
    at: string;
    revokeReason?: string;
  },
): Promise<ReportRow | null> {
  const result = await tx.query<ReportRow>(
    `UPDATE oe.reports
        SET state = $3,
            version = version + 1,
            approved_at  = CASE WHEN $3 = 'approved'  THEN $4::timestamptz ELSE approved_at END,
            published_at = CASE WHEN $3 = 'published' THEN $4::timestamptz ELSE published_at END,
            revoked_at   = CASE WHEN $3 = 'revoked'   THEN $4::timestamptz ELSE revoked_at END,
            revoke_reason = COALESCE($5, revoke_reason)
      WHERE id = $1 AND version = $2
      RETURNING ${REPORT_COLUMNS}`,
    [input.id, input.expectedVersion, input.nextState, input.at, input.revokeReason ?? null],
  );
  return result.rows[0] ?? null;
}

/* ------------------------------------------------------- idempotency */

export interface IdempotencyOutcome {
  status: 'fresh' | 'replay' | 'conflict';
  responseStatus: number | null;
  responseBody: unknown;
  recordId: string;
}

/**
 * Claim an idempotency key for this actor and operation.
 *
 * `fresh` means this caller owns the operation and must complete it. `replay` returns the
 * stored response. `conflict` means the same key arrived with different input, which
 * API_GUIDE.md maps to 409 — never to a second execution.
 */
export async function claimIdempotencyKey(
  tx: QueryExecutor,
  input: {
    id: string;
    actorId: string;
    operation: string;
    key: string;
    requestHash: string;
    expiresAt: string;
  },
): Promise<IdempotencyOutcome> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO oe.idempotency_records
       (tenant_id, id, actor_id, operation, key, request_hash, expires_at)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, $6::timestamptz)
     ON CONFLICT (tenant_id, actor_id, operation, key) DO NOTHING
     RETURNING id`,
    [input.id, input.actorId, input.operation, input.key, input.requestHash, input.expiresAt],
  );
  if (inserted.rows[0]) {
    return {
      status: 'fresh',
      responseStatus: null,
      responseBody: null,
      recordId: inserted.rows[0].id,
    };
  }
  const existing = await tx.query<{
    id: string;
    request_hash: string;
    response_status: number | null;
    response_body: unknown;
  }>(
    `SELECT id, request_hash, response_status, response_body FROM oe.idempotency_records
      WHERE actor_id = $1 AND operation = $2 AND key = $3`,
    [input.actorId, input.operation, input.key],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('Idempotency record vanished between insert and read.');
  if (row.request_hash !== input.requestHash) {
    return { status: 'conflict', responseStatus: null, responseBody: null, recordId: row.id };
  }
  return {
    status: 'replay',
    responseStatus: row.response_status,
    responseBody: row.response_body,
    recordId: row.id,
  };
}

export async function completeIdempotencyKey(
  tx: QueryExecutor,
  input: { recordId: string; responseStatus: number; responseBody: unknown },
): Promise<void> {
  await tx.query(
    'UPDATE oe.idempotency_records SET response_status = $2, response_body = $3::jsonb WHERE id = $1',
    [input.recordId, input.responseStatus, JSON.stringify(input.responseBody)],
  );
}

/* ------------------------------------------------------------- outbox */

export interface OutboxRow {
  id: string;
  aggregate_id: string;
  aggregate_type: string;
  aggregate_version: number;
  event_type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  provider_instance_id: string | null;
}

export async function insertOutboxEvent(
  tx: QueryExecutor,
  input: {
    id: string;
    aggregateId: string;
    aggregateType: string;
    aggregateVersion: number;
    eventType: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO oe.outbox
       (tenant_id, id, aggregate_id, aggregate_type, aggregate_version, event_type, payload)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type) DO NOTHING`,
    [
      input.id,
      input.aggregateId,
      input.aggregateType,
      input.aggregateVersion,
      input.eventType,
      JSON.stringify(input.payload),
    ],
  );
}

export async function getOutboxEvent(tx: QueryExecutor, id: string): Promise<OutboxRow | null> {
  const result = await tx.query<OutboxRow>(
    `SELECT id, aggregate_id, aggregate_type, aggregate_version, event_type, payload,
            status, attempts, provider_instance_id
       FROM oe.outbox WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function markOutboxDelivered(
  tx: QueryExecutor,
  input: { id: string; providerInstanceId: string | null },
): Promise<void> {
  await tx.query(
    `UPDATE oe.outbox
        SET status = 'delivered', delivered_at = now(), lease_until = NULL,
            provider_instance_id = COALESCE($2, provider_instance_id)
      WHERE id = $1`,
    [input.id, input.providerInstanceId],
  );
}

export async function markOutboxRetry(
  tx: QueryExecutor,
  input: { id: string; delaySeconds: number; error: string; maxAttempts: number },
): Promise<'retrying' | 'failed'> {
  const result = await tx.query<{ status: string }>(
    `UPDATE oe.outbox
        SET attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= $4 THEN 'failed' ELSE 'pending' END,
            available_at = now() + make_interval(secs => $2),
            lease_until = NULL,
            last_error = left($3, 2000)
      WHERE id = $1
      RETURNING status`,
    [input.id, input.delaySeconds, input.error, input.maxAttempts],
  );
  return (result.rows[0]?.status ?? 'failed') as 'retrying' | 'failed';
}

/** Cross-tenant routing keys only; the payload stays behind RLS. See migration 0005. */
export async function claimDispatchWork(
  tx: QueryExecutor,
  input: { limit: number; leaseSeconds: number },
): Promise<{ tenant_id: string; outbox_id: string; event_type: string; attempts: number }[]> {
  const result = await tx.query<{
    tenant_id: string;
    outbox_id: string;
    event_type: string;
    attempts: number;
  }>('SELECT * FROM oe_dispatch.claim($1, $2)', [input.limit, input.leaseSeconds]);
  return result.rows;
}

/* --------------------------------------------------------------- audit */

export async function insertAuditEvent(
  tx: QueryExecutor,
  input: {
    id: string;
    actorSubject: string;
    action: string;
    objectType: string;
    objectId: string;
    objectVersion: number | null;
    requestId: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO oe.audit_events
       (tenant_id, id, actor_subject, action, object_type, object_id, object_version, request_id, detail)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.id,
      input.actorSubject,
      input.action,
      input.objectType,
      input.objectId,
      input.objectVersion,
      input.requestId,
      JSON.stringify(input.detail),
    ],
  );
}

export interface AuditRow {
  id: string;
  actor_subject: string;
  action: string;
  object_type: string;
  object_id: string;
  object_version: number | null;
  request_id: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export async function listAuditEvents(tx: QueryExecutor, limit: number): Promise<AuditRow[]> {
  const result = await tx.query<AuditRow>(
    `SELECT id, actor_subject, action, object_type, object_id, object_version, request_id, detail,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM oe.audit_events ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/* ------------------------------------------------------------- ventures */

export interface VentureRow {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
}

export async function listVentures(tx: QueryExecutor): Promise<VentureRow[]> {
  const result = await tx.query<VentureRow>(
    'SELECT id, slug, name, enabled FROM oe.ventures ORDER BY slug',
  );
  return result.rows;
}

/* --------------------------------------------------------------- offers */

export interface OfferRow {
  id: string;
  venture_id: string;
  sku: string;
  version: number;
  promise: string;
  detector_families: string[];
  inclusions: string[];
  exclusions: string[];
  prerequisites: string[];
  acceptance: string[];
  currency: string | null;
  price_minor: string | null;
  tax_treatment: string | null;
  min_effort_minutes: number | null;
  max_effort_minutes: number | null;
  enabled: boolean;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
}

const OFFER_COLUMNS = `id, venture_id, sku, version, promise, detector_families, inclusions, exclusions,
  prerequisites, acceptance, currency, price_minor::text, tax_treatment,
  min_effort_minutes, max_effort_minutes, enabled, approved_by, approval_note,
  to_char(approved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS approved_at`;

/**
 * The current version of every catalogue entry this venture sells.
 *
 * A SKU version is never edited in place — approving a price or changing a scope writes a new
 * version — so "current" means the highest version, and an older quote keeps pointing at the
 * version it was drafted from.
 */
export async function listCurrentOffers(tx: QueryExecutor, ventureId: string): Promise<OfferRow[]> {
  const result = await tx.query<OfferRow>(
    `SELECT DISTINCT ON (sku) ${OFFER_COLUMNS}
       FROM oe.offers WHERE venture_id = $1 ORDER BY sku, version DESC`,
    [ventureId],
  );
  return result.rows;
}

export async function getOffer(tx: QueryExecutor, id: string): Promise<OfferRow | null> {
  const result = await tx.query<OfferRow>(`SELECT ${OFFER_COLUMNS} FROM oe.offers WHERE id = $1`, [
    id,
  ]);
  return result.rows[0] ?? null;
}

export interface OfferDraftRow {
  id: string;
  opportunity_id: string;
  offer_id: string;
  offer_sku: string;
  offer_version: number;
  state: string;
  version: number;
  currency: string;
  price_minor: string;
  snapshot: Record<string, unknown>;
  finding_ids: string[];
  root_cause_keys: string[];
  created_by: string;
  created_at: string;
  withdrawn_at: string | null;
  withdraw_reason: string | null;
}

const DRAFT_COLUMNS = `id, opportunity_id, offer_id, offer_sku, offer_version, state, version,
  currency, price_minor::text, snapshot, finding_ids, root_cause_keys, created_by, withdraw_reason,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  to_char(withdrawn_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS withdrawn_at`;

export async function insertOfferDraft(
  tx: QueryExecutor,
  input: {
    id: string;
    opportunityId: string;
    offerId: string;
    offerSku: string;
    offerVersion: number;
    currency: string;
    priceMinor: string;
    snapshot: Record<string, unknown>;
    findingIds: string[];
    rootCauseKeys: string[];
    createdBy: string;
  },
): Promise<OfferDraftRow> {
  const result = await tx.query<OfferDraftRow>(
    `INSERT INTO oe.offer_drafts
       (tenant_id, id, opportunity_id, offer_id, offer_sku, offer_version, currency, price_minor,
        snapshot, finding_ids, root_cause_keys, created_by)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, $6, $7::bigint, $8::jsonb, $9::uuid[], $10::text[], $11)
     RETURNING ${DRAFT_COLUMNS}`,
    [
      input.id,
      input.opportunityId,
      input.offerId,
      input.offerSku,
      input.offerVersion,
      input.currency,
      input.priceMinor,
      JSON.stringify(input.snapshot),
      input.findingIds,
      input.rootCauseKeys,
      input.createdBy,
    ],
  );
  return result.rows[0]!;
}

export async function listOfferDrafts(
  tx: QueryExecutor,
  opportunityId: string,
): Promise<OfferDraftRow[]> {
  const result = await tx.query<OfferDraftRow>(
    `SELECT ${DRAFT_COLUMNS} FROM oe.offer_drafts
      WHERE opportunity_id = $1 ORDER BY created_at DESC`,
    [opportunityId],
  );
  return result.rows;
}

export async function withdrawOfferDraft(
  tx: QueryExecutor,
  input: { id: string; expectedVersion: number; reason: string; at: string },
): Promise<OfferDraftRow | null> {
  const result = await tx.query<OfferDraftRow>(
    `UPDATE oe.offer_drafts
        SET state = 'withdrawn', version = version + 1,
            withdrawn_at = $4::timestamptz, withdraw_reason = $3
      WHERE id = $1 AND version = $2 AND state = 'draft'
      RETURNING ${DRAFT_COLUMNS}`,
    [input.id, input.expectedVersion, input.reason, input.at],
  );
  return result.rows[0] ?? null;
}

/** Open commitments across the workspace. Offers consume delivery hours, not just compute. */
export async function countOpenCommitments(tx: QueryExecutor): Promise<number> {
  const result = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM oe.offer_drafts WHERE state = 'draft'",
  );
  return result.rows[0]?.n ?? 0;
}

export async function getDeliveryCapacity(tx: QueryExecutor): Promise<number | null> {
  const result = await tx.query<{ concurrent_limit: number }>(
    'SELECT concurrent_limit FROM oe.delivery_capacity WHERE tenant_id = oe.tenant_context()',
  );
  return result.rows[0]?.concurrent_limit ?? null;
}

export interface OfferPrerequisiteRow {
  id: string;
  account_id: string;
  prerequisite: string;
  note: string;
  recorded_by: string;
  recorded_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

const PREREQUISITE_COLUMNS = `id, account_id, prerequisite, note, recorded_by, revoke_reason,
  to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS recorded_at,
  to_char(revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS revoked_at`;

/** Everything recorded for this account, revoked entries included: history, not current state. */
export async function listOfferPrerequisites(
  tx: QueryExecutor,
  accountId: string,
): Promise<OfferPrerequisiteRow[]> {
  const result = await tx.query<OfferPrerequisiteRow>(
    `SELECT ${PREREQUISITE_COLUMNS} FROM oe.offer_prerequisites
      WHERE account_id = $1 ORDER BY prerequisite, recorded_at DESC`,
    [accountId],
  );
  return result.rows;
}

export async function insertOfferPrerequisite(
  tx: QueryExecutor,
  input: {
    id: string;
    accountId: string;
    prerequisite: string;
    note: string;
    recordedBy: string;
  },
): Promise<OfferPrerequisiteRow> {
  const result = await tx.query<OfferPrerequisiteRow>(
    `INSERT INTO oe.offer_prerequisites
       (tenant_id, id, account_id, prerequisite, note, recorded_by)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5)
     RETURNING ${PREREQUISITE_COLUMNS}`,
    [input.id, input.accountId, input.prerequisite, input.note, input.recordedBy],
  );
  return result.rows[0]!;
}

export async function revokeOfferPrerequisite(
  tx: QueryExecutor,
  input: { accountId: string; prerequisite: string; reason: string; at: string },
): Promise<OfferPrerequisiteRow | null> {
  const result = await tx.query<OfferPrerequisiteRow>(
    `UPDATE oe.offer_prerequisites
        SET revoked_at = $4::timestamptz, revoke_reason = $3
      WHERE account_id = $1 AND prerequisite = $2 AND revoked_at IS NULL
      RETURNING ${PREREQUISITE_COLUMNS}`,
    [input.accountId, input.prerequisite, input.reason, input.at],
  );
  return result.rows[0] ?? null;
}

/** Every case a finding is linked to. A root cause can surface in more than one. */
export async function listOpportunitiesForFinding(
  tx: QueryExecutor,
  findingId: string,
): Promise<OpportunityRow[]> {
  const result = await tx.query<OpportunityRow>(
    `SELECT DISTINCT ${OPPORTUNITY_COLUMNS_O}
       FROM oe.opportunities o
       JOIN oe.opportunity_findings l ON l.tenant_id = o.tenant_id AND l.opportunity_id = o.id
      WHERE l.finding_id = $1`,
    [findingId],
  );
  return result.rows;
}

/** The state of every finding on a case, for deciding what the case is now waiting on. */
export async function findingStatesForOpportunity(
  tx: QueryExecutor,
  opportunityId: string,
): Promise<string[]> {
  const result = await tx.query<{ state: string }>(
    `SELECT f.state
       FROM oe.opportunity_findings l
       JOIN oe.findings f ON f.tenant_id = l.tenant_id AND f.id = l.finding_id
      WHERE l.opportunity_id = $1`,
    [opportunityId],
  );
  return result.rows.map((row) => row.state);
}

/* ------------------------------------------------------- requested intake */

export interface IntakeChannelRow {
  id: string;
  tenant_id: string;
  venture_id: string;
  host: string;
  enabled: boolean;
  purpose_text: string;
  purpose_version: number;
  allowed_detectors: string[];
  daily_request_limit: number;
}

const CHANNEL_COLUMNS = `id, tenant_id, venture_id, host, enabled, purpose_text,
  purpose_version, allowed_detectors, daily_request_limit`;

/**
 * Resolve a public hostname to the workspace that registered it.
 *
 * Runs on the identity connection with no tenant context, because the tenant is the answer
 * (ADR-013). Migration 0010 gives that role one narrow policy: enabled channels only, and
 * only while no context is set.
 */
export async function resolveIntakeChannel(
  tx: QueryExecutor,
  host: string,
): Promise<IntakeChannelRow | null> {
  const result = await tx.query<IntakeChannelRow>(
    `SELECT ${CHANNEL_COLUMNS} FROM oe.intake_channels WHERE host = $1 AND enabled`,
    [host.toLowerCase()],
  );
  return result.rows[0] ?? null;
}

export async function listIntakeChannels(tx: QueryExecutor): Promise<IntakeChannelRow[]> {
  const result = await tx.query<IntakeChannelRow>(
    `SELECT ${CHANNEL_COLUMNS} FROM oe.intake_channels ORDER BY host`,
  );
  return result.rows;
}

export async function getIntakeChannel(
  tx: QueryExecutor,
  id: string,
): Promise<IntakeChannelRow | null> {
  const result = await tx.query<IntakeChannelRow>(
    `SELECT ${CHANNEL_COLUMNS} FROM oe.intake_channels WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function setIntakeChannelEnabled(
  tx: QueryExecutor,
  input: { id: string; enabled: boolean },
): Promise<IntakeChannelRow | null> {
  const result = await tx.query<IntakeChannelRow>(
    `UPDATE oe.intake_channels SET enabled = $2 WHERE id = $1 RETURNING ${CHANNEL_COLUMNS}`,
    [input.id, input.enabled],
  );
  return result.rows[0] ?? null;
}

export interface IntakeRequestRow {
  id: string;
  channel_id: string;
  venture_id: string;
  target_url: string;
  target_host: string;
  requested_detectors: string[];
  purpose: string;
  authority_claim: string;
  agreed_purpose_version: number;
  contact_email: string;
  marketing_consent: boolean;
  state: string;
  version: number;
  verified_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  account_id: string | null;
  submitted_at: string;
  expires_at: string;
}

const REQUEST_COLUMNS = `id, channel_id, venture_id, target_url, target_host,
  requested_detectors, purpose, authority_claim, agreed_purpose_version, contact_email,
  marketing_consent, state, version, decided_by, decision_reason, account_id,
  to_char(verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS verified_at,
  to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS decided_at,
  to_char(submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
  to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at`;

export async function insertIntakeRequest(
  tx: QueryExecutor,
  input: {
    id: string;
    channelId: string;
    ventureId: string;
    targetUrl: string;
    targetHost: string;
    requestedDetectors: string[];
    purpose: string;
    authorityClaim: string;
    agreedPurposeVersion: number;
    contactEmail: string;
    contactEmailHash: Buffer;
    expiresAt: string;
  },
): Promise<IntakeRequestRow> {
  // `marketing_consent` is absent from this statement on purpose. Asking for a check is not
  // agreeing to be marketed to, and the surest way to keep that true is to leave the column
  // unreachable from the path a request travels.
  const result = await tx.query<IntakeRequestRow>(
    `INSERT INTO oe.intake_requests
       (tenant_id, id, channel_id, venture_id, target_url, target_host, requested_detectors,
        purpose, authority_claim, agreed_purpose_version, contact_email, contact_email_hash,
        expires_at)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11,
             $12::timestamptz)
     RETURNING ${REQUEST_COLUMNS}`,
    [
      input.id,
      input.channelId,
      input.ventureId,
      input.targetUrl,
      input.targetHost,
      input.requestedDetectors,
      input.purpose,
      input.authorityClaim,
      input.agreedPurposeVersion,
      input.contactEmail,
      input.contactEmailHash,
      input.expiresAt,
    ],
  );
  return result.rows[0]!;
}

export async function getIntakeRequest(
  tx: QueryExecutor,
  id: string,
): Promise<IntakeRequestRow | null> {
  const result = await tx.query<IntakeRequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM oe.intake_requests WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listIntakeRequests(
  tx: QueryExecutor,
  input: { ventureIds: string[]; state: string | null; limit: number },
): Promise<IntakeRequestRow[]> {
  const result = await tx.query<IntakeRequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM oe.intake_requests
      WHERE venture_id = ANY($1::uuid[])
        AND ($2::text IS NULL OR state = $2)
      ORDER BY submitted_at DESC
      LIMIT $3`,
    [input.ventureIds, input.state, input.limit],
  );
  return result.rows;
}

export async function markIntakeRequestVerified(
  tx: QueryExecutor,
  input: { id: string; at: string },
): Promise<IntakeRequestRow | null> {
  const result = await tx.query<IntakeRequestRow>(
    `UPDATE oe.intake_requests
        SET state = 'verified', version = version + 1, verified_at = $2::timestamptz
      WHERE id = $1 AND state = 'pending_verification'
      RETURNING ${REQUEST_COLUMNS}`,
    [input.id, input.at],
  );
  return result.rows[0] ?? null;
}

export async function decideIntakeRequest(
  tx: QueryExecutor,
  input: { id: string; expectedVersion: number; decidedBy: string; reason: string; at: string },
): Promise<IntakeRequestRow | null> {
  const result = await tx.query<IntakeRequestRow>(
    `UPDATE oe.intake_requests
        SET state = 'declined', version = version + 1, decided_by = $3,
            decided_at = $5::timestamptz, decision_reason = $4
      WHERE id = $1 AND version = $2 AND state IN ('pending_verification', 'verified')
      RETURNING ${REQUEST_COLUMNS}`,
    [input.id, input.expectedVersion, input.decidedBy, input.reason, input.at],
  );
  return result.rows[0] ?? null;
}

/**
 * Bind a verified request to the account an owner created from it.
 *
 * The account is what grants permission to capture anything; this only records where it came
 * from, so a later reader can see that a scan of this host began as a request rather than as
 * somebody typing a URL.
 */
export async function convertIntakeRequest(
  tx: QueryExecutor,
  input: { id: string; expectedVersion: number; accountId: string; decidedBy: string; at: string },
): Promise<IntakeRequestRow | null> {
  const result = await tx.query<IntakeRequestRow>(
    `UPDATE oe.intake_requests
        SET state = 'converted', version = version + 1, account_id = $3, decided_by = $4
      WHERE id = $1 AND version = $2 AND state = 'verified'
      RETURNING ${REQUEST_COLUMNS}`,
    [input.id, input.expectedVersion, input.accountId, input.decidedBy],
  );
  return result.rows[0] ?? null;
}

export interface IntakeVerificationRow {
  id: string;
  request_id: string;
  code_hash: Buffer;
  audience: string;
  expires_at: string;
  consumed_at: string | null;
  attempts: number;
  delivery: string;
}

const VERIFICATION_COLUMNS = `id, request_id, code_hash, audience, attempts, delivery,
  to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at,
  to_char(consumed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS consumed_at`;

export async function insertIntakeVerification(
  tx: QueryExecutor,
  input: {
    id: string;
    requestId: string;
    codeHash: Buffer;
    expiresAt: string;
    delivery: string;
  },
): Promise<IntakeVerificationRow> {
  const result = await tx.query<IntakeVerificationRow>(
    `INSERT INTO oe.intake_verifications
       (tenant_id, id, request_id, code_hash, audience, expires_at, delivery)
     VALUES (oe.tenant_context(), $1, $2, $3, 'intake_verification', $4::timestamptz, $5)
     RETURNING ${VERIFICATION_COLUMNS}`,
    [input.id, input.requestId, input.codeHash, input.expiresAt, input.delivery],
  );
  return result.rows[0]!;
}

/** The live challenge for a request, if there is one. A consumed code is not live. */
export async function getLiveVerification(
  tx: QueryExecutor,
  requestId: string,
): Promise<IntakeVerificationRow | null> {
  const result = await tx.query<IntakeVerificationRow>(
    `SELECT ${VERIFICATION_COLUMNS} FROM oe.intake_verifications
      WHERE request_id = $1 AND consumed_at IS NULL`,
    [requestId],
  );
  return result.rows[0] ?? null;
}

/**
 * Count one guess.
 *
 * Its own statement, committed whether or not the guess was right, so a wrong answer costs an
 * attempt even if the caller abandons the request afterwards.
 */
export async function recordVerificationAttempt(
  tx: QueryExecutor,
  id: string,
): Promise<number | null> {
  const result = await tx.query<{ attempts: number }>(
    'UPDATE oe.intake_verifications SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
    [id],
  );
  return result.rows[0]?.attempts ?? null;
}

/**
 * Spend the code, once.
 *
 * The `consumed_at IS NULL` predicate is the replay guard: two requests racing with the same
 * correct code produce one winner, because only one `UPDATE` can match.
 */
export async function consumeVerification(
  tx: QueryExecutor,
  input: { id: string; at: string },
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE oe.intake_verifications SET consumed_at = $2::timestamptz
      WHERE id = $1 AND consumed_at IS NULL`,
    [input.id, input.at],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * Count one hit against a rate-limit window and return the window's total.
 *
 * Runs outside any tenant context: the thing being counted crosses the tenant boundary, and a
 * per-tenant counter would give an attacker one budget per channel. See migration 0010.
 */
export async function countRateLimitHit(
  tx: QueryExecutor,
  input: { scopeKey: string; windowStart: string },
): Promise<number> {
  const result = await tx.query<{ count_hit: number }>(
    'SELECT oe_public.count_hit($1, $2::timestamptz)',
    [input.scopeKey, input.windowStart],
  );
  return result.rows[0]?.count_hit ?? 0;
}

export async function sweepRateLimits(tx: QueryExecutor, before: string): Promise<number> {
  const result = await tx.query<{ sweep_rate_limits: number }>(
    'SELECT oe_public.sweep_rate_limits($1::timestamptz)',
    [before],
  );
  return result.rows[0]?.sweep_rate_limits ?? 0;
}

/* ------------------------------------------------------- report delivery */

export interface ReportGrantRow {
  id: string;
  tenant_id: string;
  report_id: string;
  report_version: number;
  audience: string;
  recipient_note: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  created_by: string;
  created_at: string;
}

const GRANT_COLUMNS = `id, tenant_id, report_id, report_version, audience, recipient_note,
  revoke_reason, created_by,
  to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at,
  to_char(revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS revoked_at,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`;

export async function insertReportGrant(
  tx: QueryExecutor,
  input: {
    id: string;
    reportId: string;
    reportVersion: number;
    tokenHash: Buffer;
    recipientHash: Buffer;
    recipientNote: string;
    expiresAt: string;
    createdBy: string;
  },
): Promise<ReportGrantRow> {
  const result = await tx.query<ReportGrantRow>(
    `INSERT INTO oe.report_grants
       (tenant_id, id, report_id, report_version, token_hash, audience, recipient_hash,
        recipient_note, expires_at, created_by)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, 'report_access', $5, $6, $7::timestamptz, $8)
     RETURNING ${GRANT_COLUMNS}`,
    [
      input.id,
      input.reportId,
      input.reportVersion,
      input.tokenHash,
      input.recipientHash,
      input.recipientNote,
      input.expiresAt,
      input.createdBy,
    ],
  );
  return result.rows[0]!;
}

/**
 * Resolve a token to the grant it opens.
 *
 * Runs on the identity connection with no tenant context: the tenant is what this answers.
 * Migration 0012's policy is narrower than the lookup — it returns nothing for a revoked or
 * expired grant — so an expired link and a token that never existed are indistinguishable
 * here, before any code gets the chance to tell them apart.
 */
export async function resolveReportGrant(
  tx: QueryExecutor,
  tokenHash: Buffer,
): Promise<ReportGrantRow | null> {
  const result = await tx.query<ReportGrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM oe.report_grants WHERE token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export async function listReportGrants(
  tx: QueryExecutor,
  reportId: string,
): Promise<ReportGrantRow[]> {
  const result = await tx.query<ReportGrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM oe.report_grants
      WHERE report_id = $1 ORDER BY created_at DESC`,
    [reportId],
  );
  return result.rows;
}

export async function getReportGrant(
  tx: QueryExecutor,
  id: string,
): Promise<ReportGrantRow | null> {
  const result = await tx.query<ReportGrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM oe.report_grants WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Revocation takes effect on the next read. There is no session to expire and none to wait for. */
export async function revokeReportGrant(
  tx: QueryExecutor,
  input: { id: string; reason: string; revokedBy: string; at: string },
): Promise<ReportGrantRow | null> {
  const result = await tx.query<ReportGrantRow>(
    `UPDATE oe.report_grants
        SET revoked_at = $4::timestamptz, revoke_reason = $2, revoked_by = $3
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING ${GRANT_COLUMNS}`,
    [input.id, input.reason, input.revokedBy, input.at],
  );
  return result.rows[0] ?? null;
}
