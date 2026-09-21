# Architecture decisions · accepted defaults for implementation

**These are local build decisions, not proof of configured services.** Provider account, pricing, region and authorization must be verified before use. Sources [S1–S10] are in SOURCES.md.

## ADR-001 · independent internal operator

Use React, TypeScript and Vite in `apps/operator`. Deploy the static operator and same-origin `/api/v1` API through a Worker asset binding. No SEO requirement justifies an extra server-rendering runtime here. Keep existing MarktFix Astro and PDP Studio Next.js sites. TREVV consumes events later; do not import its unverified auth or inbox as a dependency. This resolves the v1 alternate “TREVV module or fallback.”

## ADR-002 · modular Worker API and durable scans

Hono + Zod in `apps/api`, shared typed contracts. Use Cloudflare Workflows for the scan lifecycle; PostgreSQL is the authoritative business-state and budget ledger. Workflow instance IDs are deterministic from tenant + scan ID. An outbox admission transaction closes the DB/workflow dual-write gap; a scheduled dispatcher retries start and records provider instance ID. Do not create a second general job framework. Keep provider adapters behind interfaces. Workflows support durable steps and retries [S5]; Hono documents Worker deployment [S9].

## ADR-003 · relational data and objects

PostgreSQL in an owner-approved EU region, Drizzle, `pg`/Hyperdrive driver as documented [S7]. Runtime database role is not owner, superuser or BYPASSRLS; migrations use a separate credential. Disable Hyperdrive query caching for tenant-sensitive application queries; use transaction-local tenant context and test pooled reuse. R2 EU-jurisdiction private objects, never public evidence buckets. Record storage region separately from processing geography. Cloudflare's global services and model calls do not become EU-only because the database/bucket is in the EU [S6,S8]. Strict-EU/private-account capture requires a separate approved processing path and is blocked until then.

## ADR-004 · authentication and membership

Cloudflare Access gates the initial internal hostname. Verify the Access assertion cryptographically on every API request: trusted issuer/JWKS, pinned expected audience, accepted algorithm, expiry and subject; never trust an email header alone [S10]. Map `(issuer, subject)` to active memberships in application storage. Require allowed tenant/venture membership and role per object operation. Access identity is not application permission. No public signup in M1. Provide a narrowly scoped local test adapter only in an isolated build; staging/production rejects it.

Same-origin UI uses the Access session and a per-session CSRF token for unsafe actions; verify Origin and token. No permissive credentialed CORS. Machine workflow callbacks use a service binding or independently verified service identity with a bounded scan/tenant claim—not a forged human header. Report access in M1 remains internal; M3 introduces a separate requested-report access token, never reused as an operator session.

## ADR-005 · capture boundary

Use Browser Run with bounded scripts only for approved public targets and approved processing policies [S6]. Page text cannot direct the browser. Protect initial URL, redirects, frames, subresources, WebSockets and downloads. M1 uses approved exact hosts, verified public destinations and a proven deny-private-network egress boundary. The included URL helper is syntax/allowlist preflight, not that network boundary. If Browser Run cannot demonstrate the required egress controls, live capture remains blocked and use a approved sandboxed Node/Playwright worker behind an egress proxy; record the adapter substitution. No CAPTCHA bypass, arbitrary JavaScript from the model, live checkout or logged-in customer session.

## ADR-006 · models and cost

No LLM in M1. M2 visual/content analysis uses a provider adapter and strict schemas, pinning provider/model/prompt version after task evaluation. Price, permissions, state and settlement are deterministic code. Model output may create a candidate but cannot mark it human-confirmed. Do not choose the most expensive model by default; evaluate evidence quality/cost on fixtures.

## ADR-007 · design ownership

Build an authored Evidence Desk, not a reskinned dashboard kit. Accessible primitives are allowed; copying a template's visual composition is not. Prototype styles are provisional. Lock tokens only after comparing genuine layout alternatives on the actual task. Accessibility and task comprehension are release gates.

## ADR-008 · dependency and runtime policy

The kit's runnable references need Node ≥22.16 and no third-party packages. For the app, resolve a currently supported Node LTS development toolchain and stable compatible package versions at M0 using official docs/registry. Commit exact versions, a lockfile and an environment manifest; test them before acceptance. Do not invent future versions or copy version claims from the historical blueprint. Pin the Worker compatibility date deliberately; deployment changes to it require integration tests. The kit does not contain an imaginary app lockfile.

## ADR-009 · rollout and authority

Local → isolated staging → approved production. Staging uses test identities/accounts/resources; fixture data cannot be toggled on in production. New resource creation, public intake, paid usage and production deployment each need owner approval. The coding agent should continue reversible local work without requesting routine preference confirmations.

## ADR format for subsequent changes

ID/date; observed problem; decision; alternatives rejected; affected contracts; security/cost implications; migration/rollback; verification; accepted/provisional status and authority. Revisit a default only for observed incompatibility or an explicit owner decision, not aesthetic preference for a different stack.
