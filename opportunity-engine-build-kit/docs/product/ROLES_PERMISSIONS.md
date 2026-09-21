# Roles and permissions

## Roles

| Capability | Viewer | Operator | Reviewer | Owner |
|---|---|---|---|---|
| Read permitted account/scan/evidence/report | Yes | Yes | Yes | Yes |
| Create/cancel a bounded scan in assigned ventures | No | Yes | Yes | Yes |
| Review findings and approve protected report | No | No | Yes | Yes |
| Draft eligible offers | No | Yes | Yes | Yes |
| Modify catalog, budgets, source policies or membership | No | No | No | Yes |
| Execute live production changes or contact prospects | No | No | No | No automatic capability |

Roles are tenant-scoped with explicit venture memberships. Owner here does not mean database owner. A worker service identity can process only assigned jobs; it cannot impersonate a reviewer or create policy grants. Role checks do not replace legal/data-processing authorization.

## Four independent gates

1. **Identity:** valid authenticated human or service.
2. **Membership:** active tenant/venture scope and object ownership.
3. **Action capability:** role permits scan/review/configure/etc.
4. **Purpose permission:** scoped source/scan/publication/contact/change record is current and permits this action on this account.

A legal controller can be shared across brands only after explicit configuration and agreements. Do not deduplicate real clients across independent tenants or expose “already exists elsewhere.” Cross-tenant object lookups return the same not-found shape; membership failures on chosen workspaces return forbidden without listing hidden accounts.

## Authorization record

ID, tenant/account, subject or merchant request, action, purpose, source evidence, allowed origins/platform scopes, granted_by, granted_at, expires_at, revoked_at and policy version. Unknown/expired/revoked is deny. M1 permits only operator-created approved research/scan records and internal report review. The system cannot declare an action lawful by calling an LLM.

## Local tests and production

Fixtures have their own isolated identities and tenants. Never expose a `dev=true` query parameter or accepted `x-tenant-id`/`x-user-role` as an authentication bypass. Application startup/deployment validation rejects a fixture-auth build on a non-loopback/external environment.

## Audit

Record actor subject, tenant, action, object/version, request ID, policy decision/version, timestamp, relevant before/after state and result. No raw tokens or unnecessary page content in logs. Security-sensitive decisions are append-only to application roles. Revocation immediately stops new reads/jobs; in-flight workers recheck before new operations.
