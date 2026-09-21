-- Opportunity Engine v2.0 · INITIAL SCHEMA CANDIDATE
-- No target database was provisioned by this kit. Apply only to an approved disposable DB first.
-- No roles/secrets/grants are created. Runtime and admin grants require the reviewed M1 adapter.
-- RLS alone does not enforce action roles or atomic budget updates; see DATA_MODEL and BUDGET_LEDGER.
BEGIN;
CREATE SCHEMA IF NOT EXISTS oe;
REVOKE ALL ON SCHEMA oe FROM PUBLIC;
CREATE FUNCTION oe.tenant_context() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 SELECT nullif(current_setting('oe.tenant_id', true),'')::uuid
$$;
REVOKE ALL ON FUNCTION oe.tenant_context() FROM PUBLIC;

CREATE TABLE oe.tenants (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK(length(name)>0),
 legal_controller text NOT NULL,
 ledger_currency char(3) NOT NULL CHECK(ledger_currency ~ '^[A-Z]{3}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oe.memberships (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
issuer text NOT NULL,
 subject text NOT NULL,
 role text NOT NULL CHECK(role IN ('viewer','operator','reviewer','owner')),
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,issuer,subject)
);

CREATE TABLE oe.ventures (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
slug text NOT NULL CHECK(slug ~ '^[a-z0-9-]+$'),
 name text NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,slug)
);

CREATE TABLE oe.member_ventures (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
membership_id uuid NOT NULL,
 venture_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,membership_id) REFERENCES oe.memberships(tenant_id,id),
 FOREIGN KEY(tenant_id,venture_id) REFERENCES oe.ventures(tenant_id,id),
 UNIQUE(tenant_id,membership_id,venture_id)
);

CREATE TABLE oe.accounts (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
venture_id uuid NOT NULL,
 name text NOT NULL,
 canonical_domain text NOT NULL CHECK(canonical_domain=lower(canonical_domain)),
 approved_hosts text[] NOT NULL CHECK(cardinality(approved_hosts)>0),
 source_note text NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,venture_id) REFERENCES oe.ventures(tenant_id,id),
 UNIQUE(tenant_id,canonical_domain)
);

CREATE TABLE oe.authorizations (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
account_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('scan_public','publish_internal_report')),
 purpose text NOT NULL,
 evidence_note text NOT NULL,
 policy_version text NOT NULL,
 granted_by uuid NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK(expires_at>granted_at),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES oe.accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,granted_by) REFERENCES oe.memberships(tenant_id,id)
);

CREATE TABLE oe.assets (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
account_id uuid NOT NULL,
 canonical_url text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES oe.accounts(tenant_id,id),
 UNIQUE(tenant_id,account_id,canonical_url)
);

CREATE TABLE oe.scans (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
account_id uuid NOT NULL,
 venture_id uuid NOT NULL,
 authorization_id uuid NOT NULL,
 target_url text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','validating','capturing','analysing','succeeded','partial','blocked','failed','cancel_requested','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 expected_unique_pages integer NOT NULL CHECK(expected_unique_pages BETWEEN 1 AND 5),
 captured_unique_pages integer NOT NULL DEFAULT 0 CHECK(captured_unique_pages BETWEEN 0 AND 5),
 reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(reasons)='array'),
 requested_by uuid NOT NULL,
 workflow_instance_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(captured_unique_pages<=expected_unique_pages),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES oe.accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,venture_id) REFERENCES oe.ventures(tenant_id,id),
 FOREIGN KEY(tenant_id,authorization_id) REFERENCES oe.authorizations(tenant_id,id),
 FOREIGN KEY(tenant_id,requested_by) REFERENCES oe.memberships(tenant_id,id),
 UNIQUE(tenant_id,workflow_instance_id)
);

CREATE TABLE oe.scan_steps (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
scan_id uuid NOT NULL,
 step_key text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','running','succeeded','blocked','failed','uncertain','cancelled')),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
 provider_request_id text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,scan_id) REFERENCES oe.scans(tenant_id,id),
 UNIQUE(tenant_id,scan_id,step_key)
);

CREATE TABLE oe.evidence (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
scan_id uuid NOT NULL,
 asset_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('screenshot','http_observation','dom_observation')),
 source_url text NOT NULL,
 final_url text NOT NULL,
 object_key text,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 conditions jsonb NOT NULL CHECK(jsonb_typeof(conditions)='object'),
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 complete boolean NOT NULL,
 redacted boolean NOT NULL DEFAULT false,
 captured_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 CHECK(expires_at>captured_at),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,scan_id) REFERENCES oe.scans(tenant_id,id),
 FOREIGN KEY(tenant_id,asset_id) REFERENCES oe.assets(tenant_id,id),
 UNIQUE(tenant_id,object_key)
);

CREATE TABLE oe.findings (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
scan_id uuid NOT NULL,
 asset_id uuid NOT NULL,
 detector_id text NOT NULL,
 detector_version text NOT NULL,
 state text NOT NULL CHECK(state IN ('candidate','confirmed','rejected','unknown','stale')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 root_cause_key text NOT NULL,
 claim text NOT NULL,
 scope text NOT NULL,
 limitations jsonb NOT NULL CHECK(jsonb_typeof(limitations)='array' AND jsonb_array_length(limitations)>0),
 evidence_grade char(1) CHECK(evidence_grade IN ('A','B','C')),
 commercial_impact text NOT NULL DEFAULT 'unknown' CHECK(commercial_impact IN ('unknown','hypothesis','measured_noncausal','validated_causal')),
 reviewer_id uuid,
 reviewed_at timestamptz,
 captured_at timestamptz NOT NULL,
 CHECK(state<>'confirmed' OR (reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL AND evidence_grade IN ('A','B'))),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,scan_id) REFERENCES oe.scans(tenant_id,id),
 FOREIGN KEY(tenant_id,asset_id) REFERENCES oe.assets(tenant_id,id),
 FOREIGN KEY(tenant_id,reviewer_id) REFERENCES oe.memberships(tenant_id,id)
);

CREATE TABLE oe.finding_evidence (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
finding_id uuid NOT NULL,
 evidence_id uuid NOT NULL,
 relationship text NOT NULL CHECK(relationship IN ('supports','contradicts')),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,finding_id) REFERENCES oe.findings(tenant_id,id),
 FOREIGN KEY(tenant_id,evidence_id) REFERENCES oe.evidence(tenant_id,id),
 UNIQUE(tenant_id,finding_id,evidence_id,relationship)
);

CREATE TABLE oe.reviews (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
finding_id uuid NOT NULL,
 finding_version integer NOT NULL CHECK(finding_version>0),
 reviewer_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('confirm','reject','unknown')),
 reason text NOT NULL CHECK(length(reason)>=5),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,finding_id) REFERENCES oe.findings(tenant_id,id),
 FOREIGN KEY(tenant_id,reviewer_id) REFERENCES oe.memberships(tenant_id,id),
 UNIQUE(tenant_id,finding_id,finding_version)
);

CREATE TABLE oe.opportunities (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
account_id uuid NOT NULL,
 venture_id uuid NOT NULL,
 title text NOT NULL,
 priority jsonb CHECK(priority IS NULL OR jsonb_typeof(priority)='object'),
 owner_id uuid,
 permission_state text NOT NULL CHECK(permission_state IN ('research_only','review_allowed','action_allowed','blocked')),
 next_action text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES oe.accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,venture_id) REFERENCES oe.ventures(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES oe.memberships(tenant_id,id)
);

CREATE TABLE oe.opportunity_findings (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
opportunity_id uuid NOT NULL,
 finding_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES oe.opportunities(tenant_id,id),
 FOREIGN KEY(tenant_id,finding_id) REFERENCES oe.findings(tenant_id,id),
 UNIQUE(tenant_id,opportunity_id,finding_id)
);

CREATE TABLE oe.reports (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
account_id uuid NOT NULL,
 scan_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('draft','approved','published','revoked','superseded')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 language char(2) NOT NULL CHECK(language IN ('en','de')),
 audience text NOT NULL DEFAULT 'internal_tenant' CHECK(audience='internal_tenant'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 body_sha256 text CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 approved_at timestamptz,
 published_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES oe.accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,scan_id) REFERENCES oe.scans(tenant_id,id)
);

CREATE TABLE oe.report_findings (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
report_id uuid NOT NULL,
 finding_id uuid NOT NULL,
 finding_version integer NOT NULL CHECK(finding_version>0),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,report_id) REFERENCES oe.reports(tenant_id,id),
 FOREIGN KEY(tenant_id,finding_id) REFERENCES oe.findings(tenant_id,id),
 UNIQUE(tenant_id,report_id,finding_id)
);

CREATE TABLE oe.budgets (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
scope_kind text NOT NULL CHECK(scope_kind IN ('tenant','venture','scan')),
 scope_id uuid NOT NULL,
 currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 limit_micro bigint NOT NULL CHECK(limit_micro BETWEEN 0 AND 999999999999999),
 reserved_micro bigint NOT NULL DEFAULT 0 CHECK(reserved_micro>=0),
 settled_micro bigint NOT NULL DEFAULT 0 CHECK(settled_micro>=0),
 paused boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,scope_kind,scope_id)
);

CREATE TABLE oe.reservations (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
scan_id uuid NOT NULL,
 operation_key text NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 reserved_micro bigint NOT NULL CHECK(reserved_micro BETWEEN 0 AND 999999999999999),
 actual_micro bigint CHECK(actual_micro>=0),
 state text NOT NULL CHECK(state IN ('reserved','uncertain','settled','released')),
 provider_request_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((state='settled')=(actual_micro IS NOT NULL)),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,scan_id) REFERENCES oe.scans(tenant_id,id),
 UNIQUE(tenant_id,operation_key)
);

CREATE TABLE oe.reservation_allocations (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
reservation_id uuid NOT NULL,
 budget_id uuid NOT NULL,
 reserved_micro bigint NOT NULL CHECK(reserved_micro>=0),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES oe.reservations(tenant_id,id),
 FOREIGN KEY(tenant_id,budget_id) REFERENCES oe.budgets(tenant_id,id),
 UNIQUE(tenant_id,reservation_id,budget_id)
);

CREATE TABLE oe.idempotency_records (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
actor_id uuid NOT NULL,
 operation text NOT NULL,
 key text NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 response_status integer,
 response_body jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES oe.memberships(tenant_id,id),
 UNIQUE(tenant_id,actor_id,operation,key)
);

CREATE TABLE oe.outbox (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
aggregate_id uuid NOT NULL,
 aggregate_type text NOT NULL,
 aggregate_version integer NOT NULL CHECK(aggregate_version>0),
 event_type text NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','delivered','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,
 delivered_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type)
);

CREATE TABLE oe.audit_events (
 tenant_id uuid NOT NULL REFERENCES oe.tenants(id),
 id uuid NOT NULL,
actor_subject text NOT NULL,
 action text NOT NULL,
 object_type text NOT NULL,
 object_id uuid NOT NULL,
 object_version integer,
 request_id text NOT NULL,
 detail jsonb NOT NULL CHECK(jsonb_typeof(detail)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);

CREATE INDEX accounts_by_venture ON oe.accounts(tenant_id,venture_id,created_at DESC,id);
CREATE INDEX scans_by_state ON oe.scans(tenant_id,state,created_at DESC,id);
CREATE INDEX evidence_by_scan ON oe.evidence(tenant_id,scan_id);
CREATE INDEX evidence_by_expiry ON oe.evidence(tenant_id,expires_at);
CREATE INDEX findings_by_scan_state ON oe.findings(tenant_id,scan_id,state);
CREATE INDEX findings_by_root ON oe.findings(tenant_id,root_cause_key);
CREATE INDEX outbox_dispatch ON oe.outbox(tenant_id,status,available_at);
CREATE INDEX reservations_pending ON oe.reservations(tenant_id,state,created_at);
CREATE INDEX opportunities_order ON oe.opportunities(tenant_id,updated_at DESC,id);
CREATE INDEX membership_identity ON oe.memberships(issuer,subject) WHERE active;

ALTER TABLE oe.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.tenants USING(id=oe.tenant_context()) WITH CHECK(id=oe.tenant_context());
ALTER TABLE oe.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.memberships USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.ventures ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.ventures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.ventures USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.member_ventures ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.member_ventures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.member_ventures USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.accounts USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.authorizations USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.assets USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.scans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.scans USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.scan_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.scan_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.scan_steps USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.evidence USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.findings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.findings USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.finding_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.finding_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.finding_evidence USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.reviews USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.opportunities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.opportunities USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.opportunity_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.opportunity_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.opportunity_findings USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.reports USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.report_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.report_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.report_findings USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.budgets USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.reservations USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.reservation_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.reservation_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.reservation_allocations USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.idempotency_records USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.outbox USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());
ALTER TABLE oe.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.audit_events USING(tenant_id=oe.tenant_context()) WITH CHECK(tenant_id=oe.tenant_context());

-- Deliberately no blanket runtime GRANT. Apply reviewed role-specific grants/functions in M1.
-- Audit/review snapshots require insert-only runtime privileges or dedicated commands.
-- Budget/reservation tables require command-only privileged transaction adapter, not generic CRUD.
COMMIT;
