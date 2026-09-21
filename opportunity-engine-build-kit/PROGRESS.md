# Progress

**Kit version 2.0 · last session 21 September 2026 (M3 slice 1)**

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
| Production database/migrations | **Local only** · 10 migrations apply to a disposable PostgreSQL 17 cluster with separate migration/runtime/identity roles. No target deployment exists |
| Live public scan adapter | **Not implemented** · `BrowserRunCaptureProvider` runs the address policy then reports `not_configured`. No egress-boundary proof, no credentials |
| Detectors | **2 of 6 implemented** · MF-LINK-01 and MF-ASSET-01, both with negative controls. MF-DATA-01, PDP-CONTENT-01, PDP-VISUAL-01 and PDP-MOBILE-01 are specified and unrequestable |
| Persistent budget enforcement | **Implemented and tested** · SQL command functions, runtime holds `SELECT` only, concurrency asserted against real connections |
| Human review and reports | **Implemented and tested** · versioned review with optimistic locking, immutable hash-bound report snapshot |
| Requested intake | **Implemented and tested, local only** · public submission, four rate-limit windows, hashed single-use codes, host-bound tenant resolution. No adapter can reach a member of the public: the only working verification channel returns the code to the caller and refuses to construct outside `APP_ENV=local` |
| Public verification delivery | **Not implemented** · the port refuses and says so. An adapter that sends mail needs owner approval it does not have |
| Offer catalogue | **Implemented and tested** · deterministic matching from an owner-approved catalogue, prerequisites recorded by a named owner, price/scope snapshotted into each draft. Nothing is sent; a draft is an internal record |
| Commercial prices | **Provisional** · EUR 290 / EUR 190 net, approved in `config/offer-approvals.json`. **VAT treatment unconfirmed** and recorded as open in both approval notes |
| OAuth, payments, outreach, TREVV integration | **Not connected** · outreach remains out of scope entirely, now for a legal reason as well as a design one (`docs/legal/DACH_OUTREACH_STUDY.md`) |
| Production deployment | **Not performed** · no cloud resource was created or contacted |

## Session log · 21 September 2026 · M3 slice 1 · requested intake

**Agent:** Claude Opus 5 · **branch:** main · **milestone:** M3, the first unauthenticated
surface.

### What was built

A stranger can ask for a check through a venture's own site: `POST /public/intake`, a one-time
code, `POST /public/intake/{id}/verify`, and a coarse status read. Operators get a queue,
a decline action and an owner switch that opens or closes a form.

Two decisions carry the slice, both in
[ADR-020](../docs/adr/ADR-020-requested-intake.md):

**The host decides the workspace.** An owner registers a public hostname; a submission
arriving there belongs to that channel's workspace. There is no tenant, venture or account
field in any public request body, and the contract has no place to add one. Resolution runs on
the identity connection with no tenant context, under one narrow policy — the same shape as
membership resolution, because it is the same problem.

**A request is not permission.** Verifying a contact address proves control of an inbox and
nothing about the website named. So a verified request is a row in a queue: no account, no
authorization, no scan, no budget movement. The requester's assertion about their own
authority is stored as a claim and rendered in the UI as a quotation, under the line "Recorded
as a claim, not established as a fact."

Around those: the same address rules as an operator-started scan (`preflightTarget` split into
`preflightAddress` plus the allowlist, rather than copied); four rate-limit windows counted
before the decision and judged together; codes hashed with a secret outside the database,
ten-minute life, five attempts, single use; and `marketing_consent` absent from the submission
path entirely, with a constraint requiring a timestamp beside it.

### Two things this got wrong first, and how

1. **The attempt ceiling did not work.** Read, count and judge ran in one transaction, and a
   wrong code threw — rolling the counter back with everything else. Five wrong guesses cost
   nothing and the sixth still worked. Now three transactions: the count commits before the
   comparison. The integration test for the ceiling found it; the comment in the code claimed
   the behaviour was already there.
2. **`verified_at` was constrained as an equality**, which forbade declining a request that
   had been verified first. Verification is a thing that happened and stays having happened;
   it is an implication now.

### Commands run and actual results

| Command | Result |
|---|---|
| `npm run typecheck` | Clean across node, web and e2e projects |
| `npm run lint` | Clean |
| `npm run format:check` | Clean |
| `npm run contract:check` | `contracts/openapi.json` matches the overlay |
| `npm run build` | Operator bundle built |
| `npm run test:unit` | **172 passed** (145 → 172; 22 new for intake, 5 for the config gate) |
| `npm run test:contract` | **52 passed** (51 → 52; the two-surface rule) |
| `npm run test:db` | **69 passed** (51 → 69; 18 new for the intake tables and counters) |
| `npm run test:integration` | **106 passed** (79 → 106; 27 new for the public surface) |
| `npm run test:e2e` | **25 passed, 7 skipped** (23 → 25) |

### Still true after this slice

- No live capture, no deployment, nothing sent to anybody.
- `PUBLIC_INTAKE_ENABLED` is on locally and off everywhere else, because there is nowhere
  else to run it: startup refuses the code-returning channel outside `APP_ENV=local`, and no
  other channel exists.
- `AUTOMATIC_OUTREACH_ENABLED`, `AUTOMATIC_PRODUCTION_WRITES_ENABLED` and
  `AUTOMATIC_TOPUPS_ENABLED` are still refused at startup.

### What M3 still owes

- **The embed** for the Astro and Next sites. The contract and the API it would call exist;
  the form does not.
- **Report access tokens** — a short-lived, hashed, audience-bound link letting a customer
  read one report version without a workspace seat, with expiry, revocation and a non-leaking
  invalid-link page.
- **Engagements** — accepted offer version, prerequisites, acceptance time, manual payment
  record with audit, and the state machine WORKFLOWS.md specifies.

### Next smallest complete task

**Report access tokens.** They are what lets a requested report reach the person who asked for
it without giving them a seat, and ACCESS_MODEL.md already names this as the one genuinely
hard case in the access model.

## Session log · 21 September 2026 · M2 slice 2 · the offer catalogue

**Agent:** Claude Opus 5 · **branch:** main · **milestone:** M2, the step between a confirmed
finding and a price.

### What was built

The catalogue step: `GET /v1/opportunities/{id}/offers` matches a case's **confirmed** findings
against the venture's catalogue; `POST .../offer-drafts` writes a scope at its approved price;
`POST /v1/offer-drafts/{id}/withdraw` withdraws one with a reason. Prerequisites are recorded
and revoked by an owner through `/v1/accounts/{id}/offer-prerequisites`.

Nothing in this slice can produce a price. Scope comes from the kit's
`config/offer-catalog.json`, which stays byte-identical; price comes from a separate
`config/offer-approvals.json` that records what the owner approved, joined on `sku@version` so
an approval cannot follow a scope to a new version. `CreateOfferDraft` carries only an
`offer_id` — there is no field through which a caller could supply a number — and the operator
UI has no price input, which the browser test asserts rather than assumes.

"Enabled requires an approved price" is stated three times: in the merge, where it names the
SKU; in the matcher, which will not return an unpriced entry; and as a CHECK constraint, which
holds against a caller that skipped both. Rationale in
[ADR-019](../docs/adr/ADR-019-offer-catalog.md).

### What the owner approved

| SKU | Price | Effort | State |
|---|---|---|---|
| `MF-LINK-REPAIR` | EUR 290 net | 1–3 h | enabled |
| `PDP-REVIEWED-AUDIT` | EUR 190 net | 0.8–1.3 h | enabled |

**VAT treatment is unconfirmed.** Both prices are net; whether VAT is added depends on a
registration status nobody has verified. Recorded as open in the approval notes, and it has to
be settled before a quote reaches a customer.

### Two gaps this slice found

1. **`apps/api/src/app.ts` claimed a test that did not exist** —
   `tests/contract/openapi-routes.test.ts`. Writing it found three read operations that were
   implemented and served but never declared in the contract: `GET /v1/scans/{id}/timeline`,
   `GET /v1/accounts/{id}/authorizations`, `GET /v1/findings/{id}/reviews`. The overlay now
   declares them, so the served contract describes every route the application mounts.
2. **The runner never moved an existing case's `next_action`.** Invisible while every case sat
   at `review_evidence` forever; once a confirmed case can reach `draft_offer`, a fresh
   candidate landing on it would have been hidden behind a next step nobody could take. The
   rule now lives in one place, `nextActionForCase`, used by both the runner and the review
   service.

### Commands run and actual results

| Command | Result |
|---|---|
| `npm run typecheck` | Clean across node, web and e2e projects |
| `npm run lint` | Clean |
| `npm run format:check` | Clean |
| `npm run contract:check` | `contracts/openapi.json` matches the overlay |
| `npm run build` | Operator bundle built |
| `npm run test:unit` | **145 passed** (119 → 145; 26 new for the matcher, the merge and `nextActionForCase`) |
| `npm run test:contract` | **51 passed** (48 → 51; the new route-conformance test) |
| `npm run test:db` | **51 passed** (38 → 51; 13 new for the constraints) |
| `npm run test:integration` | **79 passed** (64 → 79; 15 new for the draft flow) |
| `npm run test:e2e` | **23 passed, 7 skipped** (21 → 23) |

### Intermittent failures on a cold browser suite, recorded rather than explained

Twice now, the **first** browser run after `npm run db:reset` — which also restarts the dev
servers — has failed one test that passed on every subsequent clean run: once
`accessibility behaviour › keyboard reaches the case` (M2 slice 2, then 3/3 clean runs), once
`a requested check arrives as a claim` (M3 slice 1, then 2/2 clean runs). Neither left an
error context. The shared shape is a cold `tsx watch` compiling while the first test fires,
but that is a suspicion, not a finding, so both are recorded here rather than called fixed.

### Still true after this slice

- No live capture, no deployment, no outreach, nothing sent to anybody.
- A draft is an internal record. External delivery is a separate, later permission.
- `AUTOMATIC_OUTREACH_ENABLED`, `PUBLIC_INTAKE_ENABLED`, `AUTOMATIC_PRODUCTION_WRITES_ENABLED`
  and `AUTOMATIC_TOPUPS_ENABLED` are all still refused at startup.

### Next smallest complete task

~~M3 inbound intake.~~ Done in slice 1 above; see its own log for what M3 still owes.

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
next unblocked work is M3 inbound intake; see the M2 slice 2 log above.

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
