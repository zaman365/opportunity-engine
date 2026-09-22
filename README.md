# Brand Consistency Scanner

An evidence-first scanner for websites, product pages, landing pages and business pages: it
inspects an approved page, records what it actually observed, asks a person whether that
evidence supports a claim, and turns confirmed claims into a protected report. It is not a
prospecting tool and has no outbound channel of any kind.

The capability underneath is the **Consistency Engine** — capture, detectors, review, reports.
[`docs/product/PRODUCT.md`](docs/product/PRODUCT.md) says what this is and what it is not;
[`docs/roadmap`](docs/roadmap/) holds the milestones and supersedes the handoff kit's
`tasks/`. The directory and git remote are still named `opportunity-engine`; renaming them is
a separate, disruptive act and is the owner's to take.

**Status: M0, M1, M3 and M4 complete against local fixtures; M2 at 4 of 6 detectors**
(`CE-LINK-01`, `CE-ASSET-01`, `CE-DATA-01`, `CE-MOBILE-01`, all still accepted under their
handoff names).
The offer catalogue, requested intake, protected report delivery and the engagement
lifecycle are all in place. Nothing is deployed and nothing is sent: a drafted scope is an
internal record, and no adapter can reach a member of the public. Live capture, cloud
resources, payments and every integration remain unconfigured and fail closed. Read
[`opportunity-engine-build-kit/PROGRESS.md`](opportunity-engine-build-kit/PROGRESS.md) for the
capability truth table before drawing conclusions from a green test run.

## Run it locally

Needs Node ≥22.16 and a local PostgreSQL 17 installation (`initdb`, `pg_ctl`, `psql` on PATH).
Nothing here touches an existing cluster: `db:up` builds its own under `.local-postgres/` on
port 55432.

```bash
npm install
npm run db:up && npm run db:migrate && npm run db:seed
```

Then, in separate terminals:

```bash
npm run fixtures     # MF-LINK-01 fixture site on 127.0.0.1:4179 (from the build kit)
npm run fixtures:m2  # MF-ASSET-01 fixture site on 127.0.0.1:4180
npm run dev:api      # API on 127.0.0.1:4174
npm run dev:runner   # scan runner, health on 127.0.0.1:4175
npm run dev:operator # operator UI on 127.0.0.1:4173
```

Open <http://127.0.0.1:4173>. The local build resolves identity from a fixture header; pick one
of `owner@`, `operator@`, `reviewer@` or `viewer@fixture.test` when prompted. Role and workspace
still come from the database — the choice selects an identity, not a permission.

`npm run db:down -- --purge` removes the cluster entirely.

## Commands

| Command                    | What it actually does                                               |
| -------------------------- | ------------------------------------------------------------------- |
| `npm run typecheck`        | Three TypeScript projects: node, web, e2e                           |
| `npm run lint`             | ESLint, including type-aware and React rules                        |
| `npm run build`            | Typecheck plus the operator production bundle                       |
| `npm run test:unit`        | Domain logic, config validation, egress policy, capture heuristics  |
| `npm run test:contract`    | Zod ↔ OpenAPI conformance via Ajv 2020                              |
| `npm run test:db`          | Real PostgreSQL: isolation, grants, ledger concurrency              |
| `npm run test:integration` | The real API, database, capture and runner end to end               |
| `npm run test:e2e`         | Playwright against the running stack; writes the design screenshots |
| `npm run kit:test`         | The build kit's own reference suite, unchanged                      |
| `npm run contract:check`   | The served OpenAPI matches the kit's contract plus the overlay      |
| `npm run format:check`     | Prettier                                                            |
| `npm run verify`           | Every gate above, in order                                          |

`test:db`, `test:integration` and `test:e2e` require `npm run db:up` first. They fail loudly
when it is missing rather than skipping into a false green.

## Layout

```
apps/api             Hono API: auth, membership, admission, review, reports
apps/operator        React operator UI
workers/scan-runner  Outbox dispatcher and the scan workflow (MF-LINK-01, MF-ASSET-01)
packages/contracts   Zod mirrors of the served contract
contracts            overlay.json + the generated openapi.json the API serves
fixtures             The M2 synthetic product-image site
packages/domain      Scoring, money, state machine, URL policy, detectors, offer matching
docs/product         What this product is, and what it is not
docs/roadmap         Milestones. Supersedes the handoff kit's tasks/
docs/optional        Deferred scope: Shopify, TREVV, venture adapters, agency SaaS
config               Owner price approvals, separate from the kit's scope definition
packages/db          Migrations, tenant-scoped client, repositories, ledger
packages/capture     Capture port, egress guard, fixture and Browser Run adapters
packages/notify      One-time codes and the verification-channel port (no sending adapter)
packages/evidence    Private evidence object store
docs/adr             ADR-010 onward; ADR-001..009 live in the build kit
docs/design          Design log and the screenshots behind it
opportunity-engine-build-kit/   The handoff. Treat as read-only input.
```

## What this build deliberately cannot do

- **Scan anything but an approved host.** The allowlist lives on the account row; an operator
  cannot widen it, and the scan re-checks it at execution time.
- **Capture a live site.** `BrowserRunCaptureProvider` reports itself unconfigured and never
  falls back to fixture data. ADR-005 keeps it that way until a deny-private-network egress
  boundary is demonstrated and recorded.
- **Spend money outside the ledger.** The runtime database role has `SELECT` only on the budget
  tables; every write goes through SQL command functions that resolve the full cap hierarchy
  themselves.
- **Publish a claim no one reviewed.** A confirmation requires supporting evidence, no
  contradiction, unexpired artifacts and a reviewer bound to that exact finding version.
- **Run a detector it has not implemented.** One list drives the request contract, admission
  and the database constraint. The four specified-but-unbuilt detectors are unrequestable
  under either namespace.
- **Rewrite a claim somebody confirmed.** Renaming the detector namespace normalised
  configuration and left `oe.findings.detector_id` alone: a reviewer confirmed that claim
  under that id, and comparisons are canonical instead.
- **Call a sticky header an obstruction.** CE-MOBILE-01 needs an element covering a quarter of
  a phone screen _and_ overlapping the page's content, in both sessions, with no visible way to
  close it. It also cannot see overlays added by JavaScript, because captured pages are never
  executed — and says so in every finding.
- **Call a price difference a defect when tax could explain it.** CE-DATA-01 refuses a gap any
  EU VAT rate could produce, refuses when two currencies are in view, refuses a price range
  across variants, and refuses an element containing two prices. A false positive here tells a
  shop their store contradicts itself when it does not.
- **Call a slow image a broken one.** CE-ASSET-01 needs a failed request _and_ a failed render,
  agreeing across two sessions; anything pending, decorative or served in a changed product
  state is an abstention, not a claim.
- **Quote a price nobody approved.** Scope comes from the kit's catalogue, price from a
  separate owner-approval file, and "enabled requires an approved price" is a database
  constraint as well as a rule in code. There is no price input anywhere in the operator UI and
  no field in the API through which a caller could supply one.
- **Reprice a scope already given.** A draft copies its price and scope rather than referencing
  them; a catalogue change writes a new version and leaves the draft as it was quoted.
- **Assume a customer agreed to something.** A scope's prerequisites are draftable only once an
  owner records each one with a note explaining how they know — and revoking one makes the
  scope undraftable again.
- **Scan a site because somebody asked it to.** A requested check is a row in a queue.
  Verifying a contact address proves control of an inbox, not of a website; an owner still
  establishes site control and records the account and the authorization by hand.
- **Let a request pick its own workspace.** The public surface resolves the tenant from the
  host the request arrived on, matched against a channel an owner registered. There is no
  tenant field in any public request body.
- **Infer marketing consent from a request for a check.** The column is absent from the
  submission path entirely, and carries a constraint requiring a timestamp beside it.
- **Send anything.** There is no outbound adapter, no mail, no webhook and no customer
  billing. The verification-code port has one implementation that refuses and one that
  returns the code to the caller and will not construct outside `APP_ENV=local`.
- **Run fixtures in a deployed environment.** Startup validation rejects fixture auth, the
  fixture capture adapter and the local evidence store outside `APP_ENV=local`.

## Reading order

`opportunity-engine-build-kit/START_HERE.md` → `AGENTS.md` → `BUILD_SPEC.md` →
`IMPLEMENTATION_PLAN.md` → the current milestone → [`docs/adr`](docs/adr) →
[`docs/design/DESIGN_LOG.md`](docs/design/DESIGN_LOG.md).
