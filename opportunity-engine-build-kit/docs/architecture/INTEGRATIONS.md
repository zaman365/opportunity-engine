# Integration contracts and rollout

## Ports, not assumed connections

| Port | Input | Output | M1 behavior |
|---|---|---|---|
| IdentityProvider | Signed assertion | Verified issuer/subject/expiry | Access adapter; explicit local test adapter only |
| CaptureProvider | Approved scope, operation key, max cost | Capture IDs, artifact metadata, observed conditions, provider cost/status | Local fixtures first; live Browser Run only after configuration/security tests |
| WorkflowDispatcher | Committed outbox event | Deterministic instance ID, status | Durable workflow start/reconcile |
| EvidenceStore | Tenant-scoped bytes/metadata | Private object ref, hash, expiry | Local fixture objects or approved private R2, never mixed |
| ModelAnalyst | Supplied artifacts + rubric/version | Candidate observations referencing supplied IDs | Disabled in M1 |
| CatalogMatcher | Reviewed findings + prerequisites | Eligible SKU/version or manual diagnosis | M2 |
| CommerceConnector | Authorized tenant/account token | Minimal read-only records | M4 Shopify first |
| DeliveryBridge | Approved event envelope | External ref and idempotent receipt | M5 TREVV, explicit unavailable state |

All providers return `configured`, `blocked`, `retryable_error`, `permanent_error` or a result with provenance; never fabricated success. Retry budgets and idempotency belong in adapter contracts. Configuration is visible in owner settings without revealing secrets.

## Shopify first, not every platform

Before implementing: inspect current official authorization and API version docs; register only with owner authorization; request minimum needed product read scopes. Bind OAuth state to session/tenant, validate callback authenticity, encrypt token, record granted scopes, support revocation/uninstall and data deletion. No order/customer scope merely to read a catalog. Token revocation blocks new calls and marks dependent evidence availability. Compare authorized variant IDs/currency/state before asserting a conflict. Test account mismatch and expired/revoked permission.

Merchant/GA4/Amazon/Business Profile integrations remain separately scoped later work. A public scan cannot invent their account results. Do not treat generic Places data as an unrestricted prospect warehouse.

## TREVV event envelope

`event_id`, `schema_version`, `tenant_id`, `venture_id`, `event_type`, `aggregate_id`, `aggregate_version`, `occurred_at`, minimal `payload`, `trace_id`. Supported first events: engagement.ready, engagement.scope_changed, verification.completed. Sign outbound requests, allowlist endpoint, pin the actual contract after reading the real repository. Receiver must acknowledge event ID and deduplicate. Outbox retries remain visible; do not show “Task created” until receipt exists. Send permitted links/metadata rather than screenshot bytes or credentials.

## No-send boundary

An optional company research adapter must not expose campaign-start, outbound email, payment or autonomous write operations to analyst agents. Contact records are unnecessary for M1. Do not import Explee campaign endpoints simply because search endpoints exist.
