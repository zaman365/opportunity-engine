-- Membership resolution before a tenant is known.
--
-- DATA_MODEL.md: "Bootstrap/resolve membership through a separately permissioned identity
-- repository that only queries the cryptographically verified issuer/subject."
--
-- The tenant is the *answer* to that lookup, so it cannot also be its precondition: with
-- FORCE ROW LEVEL SECURITY and no context, `oe.memberships` returns nothing. Rather than
-- granting BYPASSRLS, this adds one narrow policy that applies only to the identity role and
-- only while no tenant context is set. Policies are OR-ed, so the tenant boundary for every
-- other role is unchanged, and the identity role holds SELECT on exactly two tables
-- (migration 0002) and nothing else.
DO $identity$
DECLARE identity text := current_setting('oe.identity_role', true);
BEGIN
  IF identity IS NULL OR identity = '' THEN
    RAISE EXCEPTION 'oe.identity_role must be set for migration 0006';
  END IF;
  EXECUTE format($p$
    CREATE POLICY identity_lookup ON oe.memberships
      FOR SELECT TO %I
      USING (oe.tenant_context() IS NULL AND active)
  $p$, identity);
  EXECUTE format($p$
    CREATE POLICY identity_lookup ON oe.member_ventures
      FOR SELECT TO %I
      USING (oe.tenant_context() IS NULL)
  $p$, identity);
END
$identity$;
