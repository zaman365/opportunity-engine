-- Protected report delivery.
--
-- M3: "Report links have expiry/revocation, protected evidence and a non-leaking invalid-link
-- page... tokens are random, short-lived, stored hashed and audience-bound, no PII in URL.
-- GET tokens never mutate data; prevent replay and cross-report use."
--
-- ACCESS_MODEL.md names the case this exists for: a customer who wants to see their own case
-- is **not** a viewer in the workspace. Giving them a membership would let them read every
-- other account in it, and that is the single most likely way this system leaks one
-- customer's data to another. A grant is the alternative: one report version, one recipient,
-- one clock, revocable, with no operator session attached and no route into anything else.

CREATE TABLE oe.report_grants (
  tenant_id       uuid NOT NULL REFERENCES oe.tenants(id),
  id              uuid NOT NULL,

  -- Scoped to a report AND the version it was issued against. A report that is superseded
  -- does not silently start serving newer content through a link somebody already has: the
  -- grant stops matching, and issuing a new one is a deliberate act.
  report_id       uuid NOT NULL,
  report_version  integer NOT NULL CHECK (report_version > 0),

  -- Only the hash. The token exists exactly once, in the response that created it. A reader
  -- of this table cannot reconstruct a live link, and neither can a backup of it.
  token_hash      bytea NOT NULL,
  -- What the token is for. A token minted for one purpose must not open another, and mixing
  -- the audience into the hash makes that a cryptographic fact rather than a code path.
  audience        text NOT NULL CHECK (audience = 'report_access'),
  -- Opaque handle for who it was issued to, so a grant can be found and revoked by recipient
  -- without this table holding an address.
  recipient_hash  bytea NOT NULL,
  -- Free-text label for the operator: "the person who requested the check", not an address.
  recipient_note  text NOT NULL CHECK (length(recipient_note) > 0),

  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoke_reason   text,
  revoked_by      uuid,

  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, report_id) REFERENCES oe.reports(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES oe.memberships(tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES oe.memberships(tenant_id, id),
  CHECK ((revoked_at IS NOT NULL) = (revoke_reason IS NOT NULL)),
  CHECK ((revoked_at IS NOT NULL) = (revoked_by IS NOT NULL))
);

-- A token is global, because the lookup that resolves it has no tenant to scope by — the
-- tenant is what the lookup answers. The unique index makes a collision impossible rather
-- than improbable.
CREATE UNIQUE INDEX report_grants_token ON oe.report_grants (token_hash);
CREATE INDEX report_grants_by_report ON oe.report_grants (tenant_id, report_id, created_at DESC);

ALTER TABLE oe.report_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.report_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.report_grants
  USING (tenant_id = oe.tenant_context()) WITH CHECK (tenant_id = oe.tenant_context());

DO $grants$
DECLARE
  runtime  text := current_setting('oe.runtime_role', true);
  identity text := current_setting('oe.identity_role', true);
BEGIN
  IF runtime IS NULL OR runtime = '' THEN
    RAISE EXCEPTION 'oe.runtime_role must be set for migration 0012';
  END IF;
  IF identity IS NULL OR identity = '' THEN
    RAISE EXCEPTION 'oe.identity_role must be set for migration 0012';
  END IF;

  -- Issued once, revoked but never edited: the expiry a recipient was given cannot be
  -- shortened or extended after the fact, and the report it points at cannot be swapped.
  EXECUTE format('GRANT SELECT, INSERT ON oe.report_grants TO %I', runtime);
  EXECUTE format('GRANT UPDATE (revoked_at, revoke_reason, revoked_by) ON oe.report_grants TO %I', runtime);

  -- Resolving a token happens before any tenant is known — the tenant is the answer — so it
  -- needs the same narrow treatment as membership resolution (ADR-013) and channel
  -- resolution (ADR-020): the identity role, only while no tenant context is set, and only
  -- for a grant that is still live. An expired or revoked grant is invisible to this lookup,
  -- so the public route cannot tell "expired" from "never existed" even if it wanted to.
  EXECUTE format('GRANT SELECT ON oe.report_grants TO %I', identity);
  EXECUTE format($p$
    CREATE POLICY identity_lookup ON oe.report_grants
      FOR SELECT TO %I
      USING (oe.tenant_context() IS NULL AND revoked_at IS NULL AND expires_at > now())
  $p$, identity);
END
$grants$;
