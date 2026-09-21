# API behavior details

The OpenAPI file covers the initial internal journey. It does not declare future public intake, payment or OAuth routes already built. Later milestone specs require those contracts to be added alongside implementations.

## Common request rules

Same-origin `/api/v1`, JSON UTF-8, authenticated Access session, app membership/role/purpose checks. Unsafe methods verify Origin plus a session-bound X-CSRF-Token; require Idempotency-Key. Body limit initially 32 KiB, excluding separately scoped artifact transfer. Reject unknown fields, invalid URLs, unsupported detectors and out-of-scope IDs.

Idempotency scope is tenant + actor + operation + key; canonical request hash binds body/path. Preserve original result for 24 hours minimum, and retain durable operation identity beyond response-cache expiry while side effects can still be retried. Same key/body returns original operation; altered input returns 409. Never interpret network timeout as proof no operation was admitted.

POST scans validates account/venture/authorization relationship and resolves budgets server-side. The client max_cost is an authorization ceiling, not a price quote or permission to skip lower parent limits. Initial local approved fixtures use zero external cost; live provider prices require owner-approved snapshots. Return 202 only after durable scan/outbox creation; workflow-start delay appears queued.

## Versioning

Mutable commands carry expected_version; update with `WHERE tenant_id = context AND id = :id AND version = :expected`. No matching visible row is not-found or conflict as appropriate. Review reason is retained across UI conflicts. Publish verifies every bound finding version and evidence freshness again in the same transaction as publication state change; snapshot the actual report body. Revoke immediately blocks retrieval/shares.

## Pagination and projections

Cursor encodes stable created/updated ordering plus ID; limit defaults 25, maximum 100. Validate cursor for the selected tenant/filter set. List results are role-scoped projections; do not include secrets, private storage keys, other-tenant counts or arbitrary scraped content. Detail returns supporting/contrary evidence explicitly. Approved report content is an immutable server-rendered/template snapshot, not client-generated unreviewed text.

## Status semantics

401 identity absent/invalid; 403 known user's action not allowed; 404 object absent or another tenant; 409 stale version, idempotency conflict, budget exceeded or invalid transition; 422 malformed/unsupported scope; 429 abuse/rate limit; 503 configured dependency unavailable. Store blocked scan only after valid durable admission; pre-admission validation errors do not create fake scan success.

Cross-tenant database-constraint failures must not expose hidden IDs/domains. Add request ID and retryable flag, never raw provider secrets or stack traces. UI uses stable codes and clear messages.

## Owner setup

Account creation and authorization recording are owner-only. They do not establish legality automatically; owner records the actual approved source/purpose. Initial memberships are provisioned through an audited bootstrap outside public APIs. Budget changes cannot rewrite settled history or release uncertain reservations. Resume of an overrun pause requires recorded reconciliation/reason.
