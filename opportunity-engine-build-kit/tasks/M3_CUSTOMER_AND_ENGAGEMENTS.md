# M3 · customer request and accepted scope

## Outcome

A customer can request a bounded check through a venture site, privately receive a reviewed report and accept a versioned service scope. No unsolicited campaigns.

## Tasks

Add separate public intake API with abuse rate limits, purpose text, target validation, verified request channel and per-request cost ceiling. Do not accept arbitrary unauthenticated browsing at operator limits. Pending verification spends no live budget. Separate requested report delivery from marketing consent. Add token/OTP delivery adapter only with owner approval; tokens are random, short-lived, stored hashed and audience-bound, no PII in URL. GET tokens never mutate data; prevent replay and cross-report use.

Embed intake in existing Astro/Next sites with branding intact and typed shared contract. Report links have expiry/revocation, protected evidence and a non-leaking invalid-link page. Use approved English/German templates.

Implement immutable offer versions, prerequisites, customer acceptance time/version, manual invoice/payment-status record with audit and engagement state. Optional hosted checkout requires separate integration tests and authorization; never handle card numbers. Audit fee credit, revisions, cancellation and support exclusions are explicit scope rules, not model improvisation.

## Tests/gate

Verification abuse/replay; consent not implied; cross-tenant request/report; expired/revoked share; attacker-controlled redirect; request budget exhaustion; missing integration produces unavailable; accepted outdated quote blocked; manually marked payment audited; webhook signature/replay for any implemented payment adapter. Acquire independent paid pilot engagements before claiming validated demand.
