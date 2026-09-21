# Test plan

## Delivered reference suites

`reference/*.test.mjs` exercise deterministic scoring, need deduplication, action-gate helpers, workflow transitions, money/ledger math, URL syntax/allowlist preflight and broken-link observations. `scripts/check-kit.mjs` checks file presence, contract references and configuration consistency. See VERIFICATION.md for actual run counts.

They do not instantiate production auth, cloud browsers, durable queues, PostgreSQL locks or payment providers. Do not present them as application end-to-end coverage.

## Application suites to add in M0/M1

Unit: domain conversions, redaction, scope mapping, detector assertions, stale-review checks.
Contract: Ajv 2020 validation and OpenAPI conformance, generated types, error shape, no additional properties.
Database: disposable PostgreSQL, migration from empty and prior snapshot, non-owner roles, forced RLS, composite foreign keys, concurrent reservation, serializable retry, release/settlement.
Integration: real Hono requests, valid/invalid test JWTs, workflow dispatcher duplicates, artifact ACLs, CSRF, revoked membership, outbox reconciliation.
Browser: Playwright fixture site and application in local isolated environment; operator-to-report path plus negative states. Record trace/video for failed tests with no real PII.
Staging: configured Access/Workflows/Hyperdrive/R2 and owner-approved live target; signed identities, actual cost reconciliation, re-deploy/resume. Cloud tests are explicitly skipped/blocked when resources are absent, never mocked into passing.
Security: SSRF through top-level/redirect/subresource; prompt injection fixture; stored XSS; cross-tenant IDs and signed URLs; replay; dev-auth production rejection.

## Commands

The kit ships only real commands listed in START_HERE.md. M0 must add runnable app scripts (`typecheck`, `lint`, `build`, `test:db`, `test:integration`, `test:e2e`) with actual implementations. A placeholder script that echoes success is a failed gate.

## Fixtures

Synthetic `.test` identities are reserved for tests. Local fixture server binds loopback and does not proxy arbitrary URLs. A local test-only transport may connect to it; never weaken production URL policy to make a fixture work. Correctly separate network access policy from detector logic. No live third-party request is needed for kit tests.
