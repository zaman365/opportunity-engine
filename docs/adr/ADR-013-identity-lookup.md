# ADR-013 · one narrow RLS policy for membership resolution

**2026-09-21 · accepted**

## Problem

DATA_MODEL.md requires resolving membership "through a separately permissioned identity
repository that only queries the cryptographically verified issuer/subject", and forbids
granting the general runtime unrestricted membership reads. But `oe.memberships` has
`FORCE ROW LEVEL SECURITY` with a `tenant_id = oe.tenant_context()` policy, and the tenant is
the _answer_ to the lookup, not an input — so with no context the table returns nothing.

## Decision

Migration `0006_identity_lookup.sql` adds one policy to `oe.memberships` and
`oe.member_ventures`:

```sql
CREATE POLICY identity_lookup ON oe.memberships
  FOR SELECT TO <identity_role>
  USING (oe.tenant_context() IS NULL AND active)
```

It applies to the identity role only, and only while no tenant context is set. Policies are
OR-ed, so the tenant boundary for every other role is unchanged. The identity role holds
`SELECT` on exactly those two tables and nothing else — notably not `oe.tenants`, so the
tenant's accounting currency is read separately on the runtime connection once a context
exists.

## Alternatives rejected

- **`BYPASSRLS` on a service role.** ADR-003 forbids it, and it would apply to every table.
- **A `SECURITY DEFINER` function.** `FORCE RLS` applies to the definer too, so it would have
  needed the same policy anyway, with the boundary hidden inside a function body.
- **Passing the tenant from the client.** The untrusted tenant assertion AGENTS.md forbids.

## Rollback

Drop the policy; membership resolution stops working and the API fails closed with
`MEMBERSHIP_REQUIRED`.

## Verification

`tests/db/isolation.test.ts`: the runtime role sees zero rows in every tenant-scoped table
without a context, cannot read another tenant's account by its exact UUID, and cannot link a
foreign venture. Identity resolution returns the seeded membership, nothing for an unknown
subject, and nothing for a deactivated one.
