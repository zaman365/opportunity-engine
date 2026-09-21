-- Cross-tenant dispatch routing index.
--
-- The outbox is tenant-scoped with FORCE ROW LEVEL SECURITY, so a dispatcher holding no
-- tenant context sees nothing — correct for business data, but it still has to learn which
-- tenants have pending work. Rather than granting BYPASSRLS (ADR-003 forbids a runtime role
-- that can bypass), this keeps a separate index holding only routing keys:
--   tenant_id, outbox id, event type, availability, status.
-- No payload, no claim text, no account or URL. The dispatcher reads the index, then opens a
-- normal tenant-scoped transaction to read and process the actual outbox row under RLS.

CREATE SCHEMA IF NOT EXISTS oe_dispatch;
REVOKE ALL ON SCHEMA oe_dispatch FROM PUBLIC;

CREATE TABLE oe_dispatch.outbox_index (
  tenant_id    uuid NOT NULL,
  outbox_id    uuid NOT NULL,
  event_type   text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'delivered', 'failed')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until  timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, outbox_id)
);
CREATE INDEX outbox_index_ready ON oe_dispatch.outbox_index (status, available_at);

CREATE FUNCTION oe_dispatch.sync_outbox_index() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = oe_dispatch, pg_catalog AS $$
BEGIN
  INSERT INTO oe_dispatch.outbox_index
    (tenant_id, outbox_id, event_type, status, available_at, lease_until, attempts)
  VALUES (NEW.tenant_id, NEW.id, NEW.event_type, NEW.status, NEW.available_at, NEW.lease_until, NEW.attempts)
  ON CONFLICT (tenant_id, outbox_id) DO UPDATE
     SET status = EXCLUDED.status,
         available_at = EXCLUDED.available_at,
         lease_until = EXCLUDED.lease_until,
         attempts = EXCLUDED.attempts;
  RETURN NEW;
END
$$;

CREATE TRIGGER outbox_index_sync
  AFTER INSERT OR UPDATE ON oe.outbox
  FOR EACH ROW EXECUTE FUNCTION oe_dispatch.sync_outbox_index();

-- Claim due routing keys. Leases expire so a crashed dispatcher's work is picked up again;
-- the business effect stays exactly-once because the outbox row itself is re-read and
-- compare-and-swapped inside the tenant transaction.
CREATE FUNCTION oe_dispatch.claim(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (tenant_id uuid, outbox_id uuid, event_type text, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = oe_dispatch, pg_catalog AS $$
BEGIN
  RETURN QUERY
  UPDATE oe_dispatch.outbox_index t
     SET status = 'leased',
         lease_until = now() + make_interval(secs => p_lease_seconds)
   WHERE (t.tenant_id, t.outbox_id) IN (
     SELECT c.tenant_id, c.outbox_id FROM oe_dispatch.outbox_index c
      WHERE c.available_at <= now()
        AND (c.status = 'pending' OR (c.status = 'leased' AND c.lease_until < now()))
      ORDER BY c.available_at
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit
   )
  RETURNING t.tenant_id, t.outbox_id, t.event_type, t.attempts;
END
$$;

REVOKE ALL ON FUNCTION oe_dispatch.claim(integer, integer) FROM PUBLIC;

DO $grants$
DECLARE runtime text := current_setting('oe.runtime_role', true);
BEGIN
  IF runtime IS NULL OR runtime = '' THEN
    RAISE EXCEPTION 'oe.runtime_role must be set for migration 0005';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA oe_dispatch TO %I', runtime);
  EXECUTE format('GRANT EXECUTE ON FUNCTION oe_dispatch.claim(integer, integer) TO %I', runtime);
  -- Read-only: the index is maintained by the trigger, never written by the application.
  EXECUTE format('GRANT SELECT ON oe_dispatch.outbox_index TO %I', runtime);
END
$grants$;
