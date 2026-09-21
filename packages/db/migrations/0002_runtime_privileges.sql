-- Runtime privileges. The kit's 0001 deliberately grants nothing:
-- "Deliberately no blanket runtime GRANT. Apply reviewed role-specific grants/functions in M1."
--
-- Role names are supplied by the migration runner as transaction settings, so this file
-- contains no hardcoded credentials and no role creation.
--   oe.runtime_role   application request role: non-owner, non-superuser, NOBYPASSRLS
--   oe.identity_role  membership lookup role, used before a tenant context exists
--
-- There is no GRANT ALL and no DELETE anywhere. Budget tables get SELECT only; every write
-- goes through the command functions in 0003.

DO $migration$
DECLARE
  runtime  text := current_setting('oe.runtime_role', true);
  identity text := current_setting('oe.identity_role', true);
BEGIN
  IF runtime IS NULL OR runtime = '' THEN
    RAISE EXCEPTION 'oe.runtime_role must be set for migration 0002';
  END IF;
  IF identity IS NULL OR identity = '' THEN
    RAISE EXCEPTION 'oe.identity_role must be set for migration 0002';
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA oe TO %I, %I', runtime, identity);
  EXECUTE format('GRANT EXECUTE ON FUNCTION oe.tenant_context() TO %I', runtime);

  -- Identity resolution runs before any tenant context exists, so it is a separate role
  -- with exactly two readable tables and nothing else. ROLES_PERMISSIONS.md: "Do not grant
  -- the general runtime unrestricted membership reads."
  EXECUTE format('GRANT SELECT ON oe.memberships, oe.member_ventures TO %I', identity);
  EXECUTE format('GRANT EXECUTE ON FUNCTION oe.tenant_context() TO %I', identity);

  -- Read-only reference rows.
  EXECUTE format('GRANT SELECT ON oe.tenants, oe.ventures, oe.memberships, oe.member_ventures TO %I', runtime);

  -- Owner-managed records: created through the API, never edited in place by the runtime.
  EXECUTE format('GRANT SELECT, INSERT ON oe.accounts, oe.authorizations, oe.assets TO %I', runtime);
  EXECUTE format('GRANT UPDATE (revoked_at) ON oe.authorizations TO %I', runtime);
  EXECUTE format('GRANT UPDATE (approved_hosts, name, version) ON oe.accounts TO %I', runtime);

  -- Scan lifecycle: state moves forward under compare-and-swap; identity columns are fixed.
  EXECUTE format('GRANT SELECT, INSERT ON oe.scans, oe.scan_steps TO %I', runtime);
  EXECUTE format($g$GRANT UPDATE (state, version, captured_unique_pages, reasons,
                  workflow_instance_id, updated_at) ON oe.scans TO %I$g$, runtime);
  EXECUTE format('GRANT UPDATE (state, attempt, provider_request_id, updated_at) ON oe.scan_steps TO %I', runtime);

  -- Evidence is append-only except retention/redaction metadata (DATA_MODEL.md).
  EXECUTE format('GRANT SELECT, INSERT ON oe.evidence TO %I', runtime);
  EXECUTE format('GRANT UPDATE (redacted, expires_at) ON oe.evidence TO %I', runtime);

  -- Findings carry a version counter updated by compare-and-swap review commands.
  EXECUTE format('GRANT SELECT, INSERT ON oe.findings, oe.finding_evidence TO %I', runtime);
  EXECUTE format($g$GRANT UPDATE (state, version, evidence_grade, commercial_impact,
                  reviewer_id, reviewed_at) ON oe.findings TO %I$g$, runtime);

  -- Review events are immutable history: insert and read, never update.
  EXECUTE format('GRANT SELECT, INSERT ON oe.reviews TO %I', runtime);

  EXECUTE format('GRANT SELECT, INSERT ON oe.opportunities, oe.opportunity_findings TO %I', runtime);
  EXECUTE format('GRANT UPDATE (title, priority, owner_id, permission_state, next_action, updated_at) ON oe.opportunities TO %I', runtime);

  -- Report snapshot and body hash are written once at creation; only lifecycle columns move.
  EXECUTE format('GRANT SELECT, INSERT ON oe.reports, oe.report_findings TO %I', runtime);
  EXECUTE format('GRANT UPDATE (state, version, approved_at, published_at, body_sha256) ON oe.reports TO %I', runtime);

  -- Budget ledger: readable, never writable outside the command functions in 0003.
  EXECUTE format('GRANT SELECT ON oe.budgets, oe.reservations, oe.reservation_allocations TO %I', runtime);

  EXECUTE format('GRANT SELECT, INSERT ON oe.idempotency_records TO %I', runtime);
  EXECUTE format('GRANT UPDATE (response_status, response_body) ON oe.idempotency_records TO %I', runtime);

  EXECUTE format('GRANT SELECT, INSERT ON oe.outbox TO %I', runtime);
  EXECUTE format('GRANT UPDATE (status, attempts, available_at, lease_until, delivered_at) ON oe.outbox TO %I', runtime);

  -- Audit is append-only for the runtime role.
  EXECUTE format('GRANT SELECT, INSERT ON oe.audit_events TO %I', runtime);
END
$migration$;
