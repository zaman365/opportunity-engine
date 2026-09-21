# Opportunity Engine

An evidence-first diagnostic engine: it inspects an approved page, records what it actually
observed, asks a person whether that evidence supports a claim, and turns confirmed claims into
a protected report. It is not a prospecting tool and has no outbound channel of any kind.

**Status: M0 complete, M1 complete against local fixtures.** Nothing is deployed. Live capture,
cloud resources, payments and every integration remain unconfigured and fail closed. Read
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
npm run fixtures     # synthetic site on 127.0.0.1:4179
npm run dev:api      # API on 127.0.0.1:4174
npm run dev:runner   # scan runner, health on 127.0.0.1:4175
npm run dev:operator # operator UI on 127.0.0.1:4173
```

Open <http://127.0.0.1:4173>. The local build resolves identity from a fixture header; pick one
of `owner@`, `operator@`, `reviewer@` or `viewer@fixture.test` when prompted. Role and workspace
still come from the database — the choice selects an identity, not a permission.

`npm run db:down -- --purge` removes the cluster entirely.

## Commands

| Command | What it actually does |
|---|---|
| `npm run typecheck` | Three TypeScript projects: node, web, e2e |
| `npm run lint` | ESLint, including type-aware and React rules |
| `npm run build` | Typecheck plus the operator production bundle |
| `npm run test:unit` | Domain logic, config validation, egress policy, capture heuristics |
| `npm run test:contract` | Zod ↔ OpenAPI conformance via Ajv 2020 |
| `npm run test:db` | Real PostgreSQL: isolation, grants, ledger concurrency |
| `npm run test:integration` | The real API, database, capture and runner end to end |
| `npm run test:e2e` | Playwright against the running stack; writes the design screenshots |
| `npm run kit:test` | The build kit's own reference suite, unchanged |

`test:db`, `test:integration` and `test:e2e` require `npm run db:up` first. They fail loudly
when it is missing rather than skipping into a false green.

## Layout

```
apps/api             Hono API: auth, membership, admission, review, reports
apps/operator        React operator UI
workers/scan-runner  Outbox dispatcher and the MF-LINK-01 scan workflow
packages/contracts   Zod mirrors of contracts/openapi.json
packages/domain      Scoring, money, state machine, URL policy, detector
packages/db          Migrations, tenant-scoped client, repositories, ledger
packages/capture     Capture port, egress guard, fixture and Browser Run adapters
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
- **Send anything.** There is no outbound adapter, no mail, no webhook and no customer billing.
- **Run fixtures in a deployed environment.** Startup validation rejects fixture auth, the
  fixture capture adapter and the local evidence store outside `APP_ENV=local`.

## Reading order

`opportunity-engine-build-kit/START_HERE.md` → `AGENTS.md` → `BUILD_SPEC.md` →
`IMPLEMENTATION_PLAN.md` → the current milestone → [`docs/adr`](docs/adr) →
[`docs/design/DESIGN_LOG.md`](docs/design/DESIGN_LOG.md).
