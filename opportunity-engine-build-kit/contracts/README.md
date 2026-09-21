# Contract authority and usage

`openapi.json` defines the initial internal API under `/api/v1`. It is an interface to implement, not a running service. JSON bodies are closed: reject unexpected properties. IDs are UUIDs; tenants are derived from authenticated membership, not accepted as arbitrary body data. Unsafe requests need CSRF and idempotency headers. Errors use application/problem+json with stable codes.

`domain.schema.json` is the equivalent JSON Schema 2020-12 definition set. Small finding/scan/evidence/report schemas reference it. Their `.invalid` IDs are identifiers, not endpoints to fetch; load schemas locally. Original v1 finding schema is archived under source/ and is not the v2 contract. v2 uses `id`, `version` and explicit supporting/contrary evidence relations; convert old examples deliberately.

`PriorityScore` intentionally preserves the reference scoring function's camelCase fields; the outer API uses snake_case. Do not invent an untested second scoring formula to normalize spelling. Add a tested boundary mapper only if changing this convention.

`state-machines.json` enumerates permitted edges. A listed edge does not waive required permissions, evidence invariants, budget checks or audit/version updates. `detectors.json` describes phased detectors, not deployed capabilities.

Money transports are canonical nonnegative integer micro-unit decimal strings, at most 15 digits in this initial contract. API/runtime must reject out-of-range sums before SQL overflow; record exceptional incurred overrun through a reconciled incident path rather than silently dropping cost. Monetary totals and pricing snapshots are server-authoritative. Display formatting is not the ledger.

The included kit check resolves local references and checks consistency; full schema/example validation is separately recorded in VERIFICATION.md. M0 adds the app's actual schema validator and generated types. Never fetch schema `$id` URLs at runtime.
