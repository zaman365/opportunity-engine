-- Requested intake: a stranger asks for a check, through a venture's own site.
--
-- M3: "Add separate public intake API with abuse rate limits, purpose text, target
-- validation, verified request channel and per-request cost ceiling. Do not accept arbitrary
-- unauthenticated browsing at operator limits."
--
-- Two things this deliberately does NOT do.
--
-- It does not let a request choose its tenant. BUILD_SPEC.md §14: "Clients never choose a
-- tenant by sending an arbitrary trusted body field." The tenant comes from the public host
-- the request arrived on, matched against a channel an owner registered.
--
-- It does not create authority to scan. Verifying an email proves control of an inbox, not of
-- a website. A request is a record that somebody asked; an owner still records the account
-- and the authorization before anything is captured, exactly as in M1.

/* --------------------------------------------------------------- channels */

CREATE TABLE oe.intake_channels (
  tenant_id            uuid NOT NULL REFERENCES oe.tenants(id),
  id                   uuid NOT NULL,
  venture_id           uuid NOT NULL,
  -- The public hostname a request must arrive on. Lower-case, no scheme, no port.
  host                 text NOT NULL CHECK (host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' AND host LIKE '%.%'),
  enabled              boolean NOT NULL DEFAULT false,
  -- What the requester is told before they submit: the scope, the limits, and what will
  -- happen to their address. Shown on the form and copied onto every request, so a later
  -- edit cannot change what an earlier requester actually agreed to.
  purpose_text         text NOT NULL CHECK (length(purpose_text) >= 40),
  purpose_version      integer NOT NULL DEFAULT 1 CHECK (purpose_version > 0),
  -- Detectors this channel may request. A subset of what the build implements.
  allowed_detectors    text[] NOT NULL CHECK (cardinality(allowed_detectors) > 0),
  daily_request_limit  integer NOT NULL CHECK (daily_request_limit >= 0),
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, venture_id) REFERENCES oe.ventures(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES oe.memberships(tenant_id, id)
);

-- Global, not per tenant. One host belongs to one workspace; two workspaces claiming the
-- same public hostname would make the tenant of an incoming request ambiguous, which is the
-- one thing this table exists to prevent. A hostname is a public fact, so the cross-tenant
-- visibility this implies costs nothing.
CREATE UNIQUE INDEX intake_channels_host ON oe.intake_channels (host);

/* --------------------------------------------------------------- requests */

CREATE TABLE oe.intake_requests (
  tenant_id            uuid NOT NULL REFERENCES oe.tenants(id),
  id                   uuid NOT NULL,
  channel_id           uuid NOT NULL,
  venture_id           uuid NOT NULL,

  target_url           text NOT NULL CHECK (length(target_url) BETWEEN 8 AND 2000),
  target_host          text NOT NULL CHECK (length(target_host) > 0),
  requested_detectors  text[] NOT NULL CHECK (cardinality(requested_detectors) > 0),

  -- The requester's own words about why they are asking, and what they assert about their
  -- authority over the target. Stored as given. Neither is evidence of anything; both are
  -- the record of what was claimed, by whom, when.
  purpose              text NOT NULL CHECK (length(purpose) BETWEEN 10 AND 2000),
  authority_claim      text NOT NULL CHECK (length(authority_claim) BETWEEN 10 AND 2000),
  -- The channel's purpose text at the moment of submission, so what was agreed to is fixed.
  agreed_purpose_version integer NOT NULL CHECK (agreed_purpose_version > 0),

  -- The contact address, needed to deliver what was asked for. Never in a public projection
  -- and never in a URL. The hash is what rate limiting and duplicate detection use, so those
  -- paths never handle the address itself.
  contact_email        text NOT NULL CHECK (position('@' in contact_email) > 1),
  contact_email_hash   bytea NOT NULL,

  -- Asking for a check is not agreeing to be marketed to. M3: "Separate requested report
  -- delivery from marketing consent." Default false, and nothing in the request path may set
  -- it: it can only arrive as its own explicit, separately recorded act.
  marketing_consent    boolean NOT NULL DEFAULT false,
  marketing_consent_at timestamptz,

  state                text NOT NULL DEFAULT 'pending_verification'
                         CHECK (state IN ('pending_verification', 'verified', 'declined',
                                          'expired', 'converted')),
  version              integer NOT NULL DEFAULT 1 CHECK (version > 0),
  verified_at          timestamptz,
  decided_by           uuid,
  decided_at           timestamptz,
  decision_reason      text,
  -- Set when an owner turns a verified request into an account and an authorization. The
  -- account is the thing that grants permission; this only records where it came from.
  account_id           uuid,

  submitted_at         timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,

  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES oe.intake_channels(tenant_id, id),
  FOREIGN KEY (tenant_id, venture_id) REFERENCES oe.ventures(tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES oe.memberships(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES oe.accounts(tenant_id, id),

  -- An implication, not an equivalence: verification is a thing that happened, and it stays
  -- having happened after the request is declined. Stating this as equality was wrong, and
  -- declining an already-verified request is what found it.
  CHECK (state NOT IN ('verified', 'converted') OR verified_at IS NOT NULL),
  CHECK ((state = 'declined') = (decided_at IS NOT NULL)),
  CHECK ((state = 'converted') = (account_id IS NOT NULL)),
  CHECK (marketing_consent = (marketing_consent_at IS NOT NULL))
);

CREATE INDEX intake_requests_queue
  ON oe.intake_requests (tenant_id, state, submitted_at DESC);
CREATE INDEX intake_requests_by_hash
  ON oe.intake_requests (tenant_id, contact_email_hash, submitted_at DESC);

/* ---------------------------------------------------------- verifications */

-- Proof of control of the contact address. Not proof of anything about the target.
CREATE TABLE oe.intake_verifications (
  tenant_id    uuid NOT NULL REFERENCES oe.tenants(id),
  id           uuid NOT NULL,
  request_id   uuid NOT NULL,

  -- Only the hash is stored, so a database read cannot replay a live challenge. The code
  -- itself exists exactly once, in the response to the submission that created it.
  code_hash    bytea NOT NULL,
  -- What this code is for. A code minted for one purpose must not open another.
  audience     text NOT NULL CHECK (audience = 'intake_verification'),
  expires_at   timestamptz NOT NULL,
  -- Single use. Replay of a consumed code is refused by this column, not by hoping the
  -- caller does not try.
  consumed_at  timestamptz,
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Whether the code reached a person, and how. A channel that is not configured records
  -- the attempt as undelivered rather than pretending.
  delivery     text NOT NULL CHECK (delivery IN ('recorded_local_only', 'not_configured', 'sent')),
  created_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES oe.intake_requests(tenant_id, id)
);

-- One live challenge per request. A second would double the guesses an attacker gets.
CREATE UNIQUE INDEX intake_verifications_live
  ON oe.intake_verifications (tenant_id, request_id)
  WHERE consumed_at IS NULL;

/* ----------------------------------------------------------- rate limits */

-- Fixed-window counters for an unauthenticated surface.
--
-- Deliberately outside the tenant boundary, for the same reason as the dispatch index
-- (ADR-014): the thing being counted crosses it. An attacker submitting to twenty channels
-- is one attacker, and a per-tenant counter would let them have twenty times the budget.
--
-- It holds no tenant data and no personal data. Every key is an HMAC produced by the
-- application from a secret the database never sees, so a reader of this table learns that
-- *something* was counted, not whose address or address it was.
CREATE SCHEMA IF NOT EXISTS oe_public;
REVOKE ALL ON SCHEMA oe_public FROM PUBLIC;

CREATE TABLE oe_public.rate_limits (
  scope_key    text NOT NULL CHECK (scope_key ~ '^[a-z_]+:[0-9a-f]{64}$'),
  window_start timestamptz NOT NULL,
  hits         integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
  PRIMARY KEY (scope_key, window_start)
);
CREATE INDEX rate_limits_sweep ON oe_public.rate_limits (window_start);

/*
 * Count one hit and report the window's total, atomically.
 *
 * SECURITY DEFINER so the runtime role can count without holding write privileges on the
 * table itself, and so the increment and the read are one statement: two callers racing must
 * not both see the same pre-increment total and both decide they are under the limit.
 */
CREATE FUNCTION oe_public.count_hit(p_scope_key text, p_window_start timestamptz)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = oe_public, pg_catalog AS $$
  INSERT INTO oe_public.rate_limits (scope_key, window_start, hits)
  VALUES (p_scope_key, p_window_start, 1)
  ON CONFLICT (scope_key, window_start) DO UPDATE SET hits = oe_public.rate_limits.hits + 1
  RETURNING hits;
$$;

/* Windows older than a day are noise. Called by the runner, not by a public request. */
CREATE FUNCTION oe_public.sweep_rate_limits(p_before timestamptz)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = oe_public, pg_catalog AS $$
DECLARE removed integer;
BEGIN
  DELETE FROM oe_public.rate_limits WHERE window_start < p_before;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;

/* ------------------------------------------------------- row-level security */

ALTER TABLE oe.intake_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.intake_channels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.intake_channels
  USING (tenant_id = oe.tenant_context()) WITH CHECK (tenant_id = oe.tenant_context());

ALTER TABLE oe.intake_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.intake_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.intake_requests
  USING (tenant_id = oe.tenant_context()) WITH CHECK (tenant_id = oe.tenant_context());

ALTER TABLE oe.intake_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.intake_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.intake_verifications
  USING (tenant_id = oe.tenant_context()) WITH CHECK (tenant_id = oe.tenant_context());

DO $grants$
DECLARE
  runtime  text := current_setting('oe.runtime_role', true);
  identity text := current_setting('oe.identity_role', true);
BEGIN
  IF runtime IS NULL OR runtime = '' THEN
    RAISE EXCEPTION 'oe.runtime_role must be set for migration 0010';
  END IF;
  IF identity IS NULL OR identity = '' THEN
    RAISE EXCEPTION 'oe.identity_role must be set for migration 0010';
  END IF;

  -- Channels are owner-managed. The runtime reads them and may disable one; registering a
  -- host is a bootstrap act like adding a member, not a runtime capability.
  EXECUTE format('GRANT SELECT ON oe.intake_channels TO %I', runtime);
  EXECUTE format('GRANT UPDATE (enabled) ON oe.intake_channels TO %I', runtime);

  EXECUTE format('GRANT SELECT, INSERT ON oe.intake_requests TO %I', runtime);
  EXECUTE format($g$
    GRANT UPDATE (state, version, verified_at, decided_by, decided_at, decision_reason,
                  account_id, marketing_consent, marketing_consent_at)
      ON oe.intake_requests TO %I
  $g$, runtime);

  EXECUTE format('GRANT SELECT, INSERT ON oe.intake_verifications TO %I', runtime);
  EXECUTE format('GRANT UPDATE (consumed_at, attempts) ON oe.intake_verifications TO %I', runtime);

  -- Counting only. No SELECT, no DELETE: the runtime cannot read another key's count or
  -- clear its own.
  EXECUTE format('GRANT USAGE ON SCHEMA oe_public TO %I', runtime);
  EXECUTE format('GRANT EXECUTE ON FUNCTION oe_public.count_hit(text, timestamptz) TO %I', runtime);
  EXECUTE format('GRANT EXECUTE ON FUNCTION oe_public.sweep_rate_limits(timestamptz) TO %I', runtime);

  -- Resolving host → tenant happens before any tenant is known, so it needs the same narrow
  -- treatment as membership resolution (ADR-013): the identity role, and only while no
  -- tenant context is set. Policies are OR-ed, so every other role's boundary is unchanged.
  EXECUTE format('GRANT SELECT ON oe.intake_channels TO %I', identity);
  EXECUTE format($p$
    CREATE POLICY identity_lookup ON oe.intake_channels
      FOR SELECT TO %I
      USING (oe.tenant_context() IS NULL AND enabled)
  $p$, identity);
END
$grants$;
