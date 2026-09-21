# Progress

**Kit version 2.0 · last session 21 September 2026 (M2 slice 1)**

## Completed in this kit

Product/research preservation; build plan and milestone instructions; visual/UI/UX brief and
interactive concept; domain/API contracts; SQL migration candidate; deterministic reference
modules and tests; fixtures; runbooks; agent prompts. Exact executed checks are in
VERIFICATION.md.

## Application capability truth

| Capability | Status |
|---|---|
| Production application scaffold | **Built** · monorepo, pinned versions, lockfile, real build/type/lint/test scripts |
| Live authentication/membership | **Partly** · Access JWT verification implemented (jose, pinned issuer/audience/algorithms) but never exercised against a real Access deployment. The local fixture identity is the only path actually run |
| Production database/migrations | **Local only** · 8 migrations apply to a disposable PostgreSQL 17 cluster with separate migration/runtime/identity roles. No target deployment exists |
| Live public scan adapter | **Not implemented** · `BrowserRunCaptureProvider` runs the address policy then reports `not_configured`. No egress-boundary proof, no credentials |
| Detectors | **2 of 6 implemented** · MF-LINK-01 and MF-ASSET-01, both with negative controls. MF-DATA-01, PDP-CONTENT-01, PDP-VISUAL-01 and PDP-MOBILE-01 are specified and unrequestable |
| Persistent budget enforcement | **Implemented and tested** · SQL command functions, runtime holds `SELECT` only, concurrency asserted against real connections |
| Human review and reports | **Implemented and tested** · versioned review with optimistic locking, immutable hash-bound report snapshot |
| OAuth, payments, outreach, TREVV integration | **Not connected** · outreach remains out of scope entirely |
| Production deployment | **Not performed** · no cloud resource was created or contacted |

## Session log · 21 September 2026 · M2 slice 1 · MF-ASSET-01

**Agent:** Claude Opus 5 · **branch:** main · **milestone:** M2, first detector slice.

### What was built

MF-ASSET-01 end to end: new fixtures, subresource capture, a browser-measured rendered check,
the detector, its evidence model, the contract extension, and the workbench changes to show it.

The rule requires **both halves** of the proof `contracts/detectors.json` specifies — a
resource failure *and* a rendered failure — agreeing across two independent comparable
sessions. Each declared abstention (`blocked`, `pending_lazy_load`, `decorative_image`,
`variant_changed`) has a fixture route and a test. Rationale in
[ADR-017](../docs/adr/ADR-017-asset-detector.md).

Images are subresources: they never change the page denominator. Each one is its own evidence
row so a finding can cite the exact observation it rests on.

### Contract handling

The kit's `contracts/openapi.json` stays byte-identical. `contracts/overlay.json` states each
M2 change as one pointer assignment with a reason; `scripts/build-contract.mjs` generates the
served document. Tests prove regeneration is deterministic, every M1 operation and role
survives, and request schemas only widen while response schemas may narrow.
[ADR-018](../docs/adr/ADR-018-contract-overlay.md).

### Commands run and actual results

| Command | Result |
|---|---|
| `npm run kit:test` | 114 tests passed; 849 structural checks; 22 API operations |
| `npm run typecheck` | Clean across node, web and e2e projects |
| `npm run lint` | Clean |
| `npm run format:check` | Clean — the repository is now formatted, so the gate is real |
| `npm run contract:check` | `contracts/openapi.json` matches the overlay |
| `npm run build` | Operator bundle built |
| `npm run test:unit` | **119 passed** (86 → 119; 33 new for MF-ASSET-01) |
| `npm run test:contract` | **48 passed** (29 → 48; 19 new for the generated contract) |
| `npm run test:db` | **38 passed** |
| `npm run test:integration` | **64 passed** (51 → 64; 13 new for MF-ASSET-01) |
| `npm run test:e2e` | **21 passed, 7 skipped** (17 → 21) |

### Fixture matrix and what each proves

| Route | Verdict | Proves |
|---|---|---|
| `product-broken-image` | candidate, grade A, HTTP 404 | known positive |
| `product-empty-image` | candidate, 200 with empty body | request succeeded, nothing rendered |
| `product-healthy` | no finding | negative control |
| `product-lazy` | no finding, "still loading when the bounded wait expired" | a slow image is not a broken one |
| `product-decorative-broken` | no finding, 1 of 2 classified product | a decorative failure is not a product defect |
| `product-variant` | no finding, "different product state between checks" | two states are not comparable |

### Bugs found and fixed during this slice

Four were truthfulness bugs rather than polish, and three of the four were caught by a test or
a rendered screen rather than by reading the code:

1. **The renderer injected markup with `setContent`**, leaving the document at `about:blank`,
   where root-relative image paths resolve to nothing. Every image read as unrendered, which
   would have turned every healthy page into a false positive. It now navigates to the real
   URL with the response fulfilled from recorded bytes.
2. **The interpretation paragraph was written for a broken link** and shown on image findings.
3. **The banner still claimed MF-LINK-01 was the only detector.** The list now comes from the
   server via the session, so a stale bundle cannot advertise a capability a deployment lacks.
4. **Importing the detector list from `@oe/domain` pulled `node:net` into the browser bundle**
   and broke every page at runtime. An ESLint rule now forbids server-only imports in anything
   the bundle ships.

Also: an off-by-one in the `<main>` range check placed an image written immediately after
`<main>` outside the content area — that is, a page's primary product image. Found by a unit
test written before the fixture that would have hidden it behind whitespace.

### Blocked, unchanged from the last session

Live capture, cloud resources, deployment, payments, outreach and the remaining four detectors.
`/api/ready` names the missing bindings. Nothing cloud-shaped is mocked or marked complete.

### Next smallest complete task

**MF-DATA-01** — structured product facts conflicting with displayed facts. It reuses the page
capture unchanged and needs one new extraction step (JSON-LD plus the visible price), with
abstentions for `variant_unknown`, `multi_currency`, `aggregate_offer` and
`unavailable_variant_context`. The fixture set needs a matched-variant positive, a
multi-currency abstention and a healthy control.

Before that, one thing is worth doing first: **the offer catalog is still unwired.** Two
detectors now produce findings and nothing maps a confirmed finding to an eligible SKU. M2's
task file puts catalog matching alongside the detectors, and doing it after two detectors
rather than after six keeps the mapping honest while the evidence is still fresh.

## Session log · 21 September 2026 · M0 and M1

**Agent:** Claude Opus 5 · **branch:** main · **milestone:** M0 complete, M1 complete against
local fixtures.

### Inspected facts and authority limits

Repository held only this kit, untracked, on `main`. `npm test` passed unchanged before any
edit (114 reference tests, 849 structural checks) and passes now. No owner authorization exists
for cloud resources, live capture, paid usage, outreach or deployment, so none was attempted.
Local PostgreSQL 17.11 and a Chromium for Playwright were available and used; both are local
development tools, not provisioned services.

The kit is treated as read-only input. `db/001_core.sql` is copied into
`packages/db/migrations/0001_core.sql` byte-identically (sha256
`579fc295…75ea` on both). The only kit file this session edits is this one.

### Files changed

Application added at the repository root beside the kit:

- `packages/contracts` — Zod mirrors of all 29 OpenAPI component schemas, stable error codes
- `packages/domain` — TypeScript port of the reference modules plus fail-closed config loading
- `packages/db` — 8 migrations, tenant-scoped client, repositories, ledger wrapper
- `packages/capture` — capture port, egress guard, fixture transport, Browser Run adapter,
  Playwright renderer, two target policies
- `packages/evidence` — private filesystem store; the R2 adapter is inert by design
- `apps/api` — Hono API, Access/fixture identity, CSRF, idempotency, admission, review, reports
- `apps/operator` — React operator UI and the D0 composition studies
- `workers/scan-runner` — outbox dispatcher and the MF-LINK-01 workflow
- `tests/` — unit, contract, db, integration and Playwright suites
- `docs/adr/ADR-010..016`, `docs/design/DESIGN_LOG.md`, 19 screenshots, `README.md`
- `scripts/dev-postgres.mjs`, `scripts/seed-local.ts`

### Commands run and actual results

| Command | Result |
|---|---|
| `npm run kit:test` | 114 tests passed; 849 structural checks; 22 API operations |
| `npm run typecheck` | Clean across node, web and e2e projects |
| `npm run lint` | Clean |
| `npm run build` | Operator bundle built; 331 kB js / 18 kB css |
| `npm run test:unit` | **86 passed** — reference parity, config, egress, capture heuristics |
| `npm run test:contract` | **29 passed** — Ajv 2020 and Zod agree on every example and negative |
| `npm run test:db` | **38 passed** — isolation, grants, ledger concurrency |
| `npm run test:integration` | **51 passed** — real API, database, capture, runner |
| `npm run test:e2e` | **17 passed, 5 skipped** — desktop 1440×960 and narrow 390×844 |

Skipped e2e cases are desktop-only scenarios deliberately not repeated at narrow width; each
carries its reason in `test.skip`.

### What the M1 journey actually does

Operator authenticates → membership resolves from the database → an approved account and an
approved host are selected → scope and cap are stated before confirmation → admission commits
scan, asset, scan-scoped cap, hierarchical reservation, outbox event, audit event and the
idempotency claim in **one transaction**, returning 202 only after commit → the dispatcher
claims routing keys and the runner re-checks authorization, captures the page in two clean
sessions, classifies at most one informational link, captures its destination twice, runs
MF-LINK-01 → a candidate finding with real evidence IDs, limitations and detector version →
a reviewer confirms against an exact version → a report binds those versions, renders once and
is hash-sealed → approve → publish → revoke.

Verified negative paths: unapproved host, state-changing path, token-bearing URL, wrong
currency, unsupported detector, cross-tenant account, unknown body field, missing idempotency
key, paused cap, cap below worst case, revoked authorization mid-flight, access challenge,
healthy control, rejected finding excluded from any report, expired artifacts blocking
confirmation, contrary evidence blocking confirmation, stale review, duplicate outbox delivery,
process restart, cancellation, unconfigured provider, and fixture auth refused for a deployed
origin.

### Screens captured and critique fixes

Three passes recorded in `docs/design/DESIGN_LOG.md` with 19 screenshots. Nine issues found and
fixed, including two that were truthfulness bugs rather than polish:

1. A complete inspected page rendered as "Not captured" because the case drew its grid from the
   opportunity payload, which carries only the evidence a finding cites.
2. The soft-404 heuristic matched a bare `404` anywhere in body text, so the product fixture —
   whose copy mentions the status code — was wrongly labelled ambiguous. A false abstention
   silently discards a valid observation.

### Implemented but not verified

- **Cloudflare Access JWT verification.** The code pins issuer, audience, algorithms and expiry
  through `jose`, but no Access deployment exists, so it has never run against a real assertion.
- **Drizzle.** Declared per ADR-003; M1 data access is parameterised SQL chosen for the
  column-level grants. No Drizzle schema has been exercised.
- **The R2 evidence store.** Deliberately inert. It throws rather than writing anywhere.
- **Playwright `webServer` reuse** assumes the local ports are free.

### Blocked by missing external authority

| Blocked | Needs | What still works locally |
|---|---|---|
| Live capture of any public site | Owner authorization, Browser Run credentials, an approved processing policy, and demonstrated deny-private-network egress (ADR-005) | Fixture capture, the full address policy, and an honest `not_configured` |
| Deployed database, R2, Workflows, Access | Cloud account and owner approval | Disposable local PostgreSQL and filesystem evidence |
| Any deployment | Owner approval (ADR-009) | Local build and the full test matrix |
| Public intake, payments, outreach, TREVV | Their milestones and separate approvals | Nothing — these are absent, not switched off |

Cloud paths are neither mocked nor marked complete. `missing_bindings` on `/api/ready` names
them.

### Next smallest complete task

**M1 increment 5 — the live capture adapter — is blocked** on the authorizations above. The
next unblocked work is the first slice of M2: implement **MF-ASSET-01** against new local
fixtures (a resource that fails, one that lazy-loads slowly, one decorative image, one variant
change), including its negative controls, before touching any other detector. It reuses the
existing capture port, evidence model, review path and report composer unchanged — which is the
point of having built one detector end to end first.

## Session log template

Date / agent / branch / milestone:

- Inspected facts and irreversible authority limits:
- Files changed:
- Commands run and actual exit/results:
- Screens captured and critique fixes:
- Implemented but not verified:
- Blocked dependency and what remains possible locally:
- Next smallest complete task:

Never erase a failed gate without recording the fix and a successful rerun. Keep this file
compact; archive detailed session logs under ops/session-logs/ when necessary.
