# Implementation plan

**One codebase, staged capabilities.** These are build gates, not calendar promises. Production is never inferred from completion of local tests.

## Fixed starting shape

Independent React/TypeScript/Vite operator; Hono Worker API; Cloudflare Access plus application JWT verification; PostgreSQL/Drizzle through Hyperdrive; Workflows; private R2; bounded Browser Run adapter for approved public pages. Local adapter fixtures remain separate. No app dependency on TREVV. See architecture/DECISIONS.md for tradeoffs and exceptions.

## Milestones

| ID | Complete capability | Depends on | Exit evidence |
|---|---|---|---|
| M0 | Repository audit, actual scaffold, contracts, design exploration and dev setup | Kit | Locked dependencies; app builds; auth fails closed; design decision record; baseline checks |
| M1 | Internal one-detector scan-to-reviewed-report workflow | M0 | Real authorized captures + durable records + rejected/blocked paths + DB isolation/concurrency tests |
| M2 | Remaining five detectors and offer qualification | M1 | Adjudicated detector fixtures, unknown handling, catalog constraints, evidence-backed reports |
| M3 | Requested customer intake, protected delivery and commercial conversion | M1; use M2 for wider offer scope | Verified request channel, abuse controls, expiring report access, accepted versioned scope |
| M4 | One authorized Shopify read integration and before/after verification | M2–M3 | OAuth/security review, revocation, minimal scopes, actual read-only account tests |
| M5 | Monitoring and TREVV outbox handoff | M4 | Idempotent events, recurrence detection, triage ownership, failed handoff recovery |
| M6 | Paid pilot hardening; one additional venture adapter only if justified | Prior gates | Restore drill, incident/runbook evidence, commercial contribution and delivery capacity |

### First working slice

Operator signs in → membership resolved → approved account/URL selected → explicit scan scope and cap → durable scan admission → safe collection in two clean sessions → MF-LINK-01 candidate with actual evidence → human review → protected, versioned report. A failed or blocked scan stays visible and does not become a fabricated result.

### Important ordering

Safety, isolation, atomic budgets and real state transitions are in M1, not cleanup. Build API/domain behavior and UI together around this journey. Do not complete all backend modules before rendering evidence; do not render fake analytics while waiting for backend work.

## Working increments inside M1

1. Contracts/schema + persistence + runtime-role tests.
2. Auth/membership + permitted account creation + ownership/scope records.
3. Admission transaction + outbox/workflow dispatcher + reservation accounting.
4. Local fixture capture adapter; no production fallback.
5. Approved live capture adapter, network-policy tests and recorded costs.
6. Detector, review optimistic locking and protected report.
7. Browser acceptance, operational failure cases and visual critique.

Each increment leaves a reproducible command or test. Missing paid infrastructure can block increment 5 without blocking contract, fixture, UI or DB work; report the precise gap.

## Build task definition

Every task has: outcome; prerequisites; files/contracts touched; observable behavior; negative cases; verification commands; done evidence. Persist status as `not_started`, `in_progress`, `blocked`, `implemented_unverified`, or `verified`. “Done” is not a synonym for files existing.

## Design is a parallel workstream with gates

D0: two or three genuinely different compositions for the same populated case, not palette variations. D1: select a direction by task performance and authored visual character; record rationale. D2: prove list → evidence → decision across mobile/desktop and edge states. D3: derive tokens/components from the working composition. D4: three-pass critique and browser screenshots. Lack of owner feedback allows a clearly provisional local design choice; it does not authorize external deployment.

## Later scope

The phase files define required behavior and tests for the later platform. Re-open provider scopes and current documentation when implementing each connector. Do not provision all services in M0 or treat an unavailable integration as complete because its menu item exists.
