# Verification record · build kit 2.0

**Checked during handoff preparation, 21 September 2026.** A passing handoff check is not a deployed-platform acceptance result.

## Executed checks

| Check | Actual scope | Result |
|---|---|---|
| Node reference suite | Scoring, unknowns, root-cause aggregation, permission readiness reference, state edges, narrow URL preflight, link assertion, and in-memory budget reference | **114 tests passed** |
| JSON Schema checks | 29 schema structures, 6 positive synthetic payloads, 15 negative payloads, with format checking | **50 checks passed** |
| Interactive design prototype | Search/filter/empty state, evidence controls, dialogs, required review reason, local confirm/reject/report gating, unknown states, mobile queue and layouts, reduced motion | **31 checks passed** |
| Handbook | Self-contained navigation, document search, embedded prototype launch, responsive layout and JavaScript errors | **16 checks passed** |
| Local handoff HTTP server | Allowed pages, unknown/prototype-key paths, blocked secrets path, read-only methods and HEAD | **8 checks passed** |
| Preservation | Original blueprint and original scoring implementation/tests | Byte-identical copies verified |
| Fixture responses | Local HTTP 200, 404 and 403 responses plus browser rendering of their original HTML in isolated contexts | Eight recorded captures; see fixture manifest |
| Handoff integrity | Required files, parseable JSON, local schema references, unique operations, state targets, safe config defaults, no font binaries | Dependency-free `npm run check:kit`; see saved output |
| Visual critique | Desktop and narrow-screen inspection plus heuristic task walkthrough and revision | Recorded in design/DESIGN_DECISIONS.md; not participant research |

The M1 OpenAPI candidate describes **22 operations**. Its local references and component schemas were checked. This is not equivalent to validating it with a full OpenAPI conformance validator or serving those endpoints.

## Reproduce the default checks

Node 22.16 or newer; no dependency installation needed for the reference kit:

```bash
npm test
```

Optional deeper authoring checks require the Python packages listed in `verification/requirements.txt` and an available Chromium installation:

```bash
python scripts/validate-contracts.py
python scripts/test-preview.py
```

`CHROMIUM_PATH` can point to an approved browser executable. The optional `ALLOW_UNSANDBOXED_LOCAL_FIXTURE=1` switch is only for isolated local synthetic rendering where a sandbox cannot start; it is not a production capture configuration. Prefer running with the browser sandbox enabled.

## Important environment limitation

Direct Chromium navigation to the loopback fixture server was blocked by the authoring environment's browser policy. The local HTTP client read the original fixture response and its real status, then Chromium rendered that original HTML using `set_content` in isolated contexts. Capture manifests and prototype captions record this method. These are synthetic fixture evidence demonstrations—not successful end-to-end browser crawls of a merchant.

Prototype interaction checks likewise load the self-contained HTML using `set_content`. They verify local UI behavior, not authentication, backend persistence or network integration. Screenshots in `verification/` document the rendered result. Full keyboard/assistive-technology testing and a WCAG audit are still required for the app.

## Not executed or not implemented

No application scaffold, identity provider, cloud capture service, production database, live merchant scan, OAuth connection, payment flow, email, production write or deployment was created. No external repositories were modified.

The SQL is an **initial schema candidate**, not a database whose migrations, grants or RLS behavior were executed. PostgreSQL tooling was unavailable in this environment. An attempt to add optional SQL/OpenAPI parsing dependencies was blocked by package-network resolution; no full SQL parser or full OpenAPI validator was run. M0/M1 must run those checks against the actual pinned stack and disposable PostgreSQL before using the migration.

The in-memory budget tests do not demonstrate persistent transactions under concurrent workers. Atomic reservations, outbox dispatch, ambiguous provider settlement, permission revocation and cross-tenant isolation require the database/integration tests specified in the milestones.

## Interpreting status correctly

- Reference logic tested ≠ the application implemented.
- JSON Schema-valid payload ≠ an authorized or truthful business action.
- Attractive interactive concept ≠ complete production UI or research-validated design.
- A fixture 404 ≠ a finding about a real company.
- Source documentation consulted ≠ the connected repository's deployment verified.

Read `PROGRESS.md` for capability status and `docs/quality/ACCEPTANCE.md` for release gates.
