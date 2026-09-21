-- Additive columns the M1 application needs. The kit's 0001 stays byte-identical; this file
-- is the reviewed extension rather than a second divergent schema (DATA_MODEL.md).
--
-- Every column here is nullable or defaulted, so the migration is backward-compatible and
-- reversible by dropping the columns.

-- WORKFLOWS.md: "A terminal scan never restarts in place; a rerun creates a new scan with
-- supersedes_scan_id and new cost authorization."
ALTER TABLE oe.scans
  ADD COLUMN supersedes_scan_id uuid,
  ADD COLUMN detectors text[] NOT NULL DEFAULT ARRAY['MF-LINK-01']::text[],
  ADD COLUMN cancel_requested_at timestamptz,
  ADD CONSTRAINT scans_supersedes_fk
    FOREIGN KEY (tenant_id, supersedes_scan_id) REFERENCES oe.scans(tenant_id, id),
  ADD CONSTRAINT scans_detectors_supported
    CHECK (detectors <@ ARRAY['MF-LINK-01']::text[] AND cardinality(detectors) >= 1);

-- Which role a capture plays in the MF-LINK-01 comparison, and which of the two clean
-- sessions produced it. The detector needs both to prove the observations are independent
-- and comparable; without them "two captures" cannot be distinguished from one retried twice.
ALTER TABLE oe.evidence
  ADD COLUMN capture_role text NOT NULL DEFAULT 'source_page'
    CHECK (capture_role IN ('source_page', 'link_destination')),
  ADD COLUMN session_ordinal integer NOT NULL DEFAULT 1 CHECK (session_ordinal BETWEEN 1 AND 4),
  ADD COLUMN context_key text NOT NULL DEFAULT 'unspecified',
  ADD COLUMN observation jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(observation) = 'object');

-- The detector's own output for the candidate, kept verbatim so a reviewer can see what the
-- rule actually returned rather than a re-rendered summary.
ALTER TABLE oe.findings
  ADD COLUMN detector_output jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detector_output) = 'object'),
  ADD COLUMN target_url text,
  -- Freshness: the evidence this finding rests on expires independently of the finding row.
  ADD COLUMN evidence_fresh_until timestamptz;

-- A published report's rendered body is immutable and hash-bound; store it next to the hash
-- column 0001 already defines so publication does not depend on re-rendering live rows.
ALTER TABLE oe.reports
  ADD COLUMN body jsonb,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoke_reason text;

-- Dispatcher bookkeeping: the deterministic workflow instance ID is queried before a retry,
-- so a timed-out start cannot create a second run.
ALTER TABLE oe.outbox
  ADD COLUMN last_error text,
  ADD COLUMN provider_instance_id text;

CREATE INDEX evidence_by_role ON oe.evidence(tenant_id, scan_id, capture_role, session_ordinal);
CREATE INDEX reports_by_scan ON oe.reports(tenant_id, scan_id, created_at DESC);
CREATE INDEX reviews_by_finding ON oe.reviews(tenant_id, finding_id, created_at DESC);
CREATE INDEX scans_by_account ON oe.scans(tenant_id, account_id, created_at DESC, id);

DO $grants$
DECLARE runtime text := current_setting('oe.runtime_role', true);
BEGIN
  IF runtime IS NULL OR runtime = '' THEN
    RAISE EXCEPTION 'oe.runtime_role must be set for migration 0004';
  END IF;
  -- Column-level grants from 0002 do not extend to columns added later.
  EXECUTE format('GRANT UPDATE (cancel_requested_at) ON oe.scans TO %I', runtime);
  EXECUTE format('GRANT UPDATE (evidence_fresh_until) ON oe.findings TO %I', runtime);
  EXECUTE format('GRANT UPDATE (revoked_at, revoke_reason) ON oe.reports TO %I', runtime);
  EXECUTE format('GRANT UPDATE (last_error, provider_instance_id) ON oe.outbox TO %I', runtime);
END
$grants$;
