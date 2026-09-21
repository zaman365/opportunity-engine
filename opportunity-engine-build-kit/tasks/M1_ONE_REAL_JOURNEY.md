# M1 · one real scan-to-report journey

## Outcome

Authenticated internal operator selects an approved account/URL, runs MF-LINK-01, reviews real recorded evidence and produces a protected versioned report. Default scope is one source PDP plus up to three important informative link targets, within five unique page URLs total. Two clean sessions recheck a selected target without doubling the logical-page denominator; request and byte limits remain independent.

## 1 · persistence and identity

Apply candidate schema in disposable PostgreSQL; implement membership resolution and API object guards. Verify signed Access assertions in configured environments. Use real runtime non-owner role and transaction-scoped tenant context. Test foreign-key cross-tenant insertion and private evidence lookup, not just list filtering. Complete the budget transaction adapter; reference math is not enough.

## 2 · account and permission setup

Owner creates an approved account, exact hosts, purpose/expiry and no-send permissions. Operator cannot expand the host policy. New account from intake requires owner review before live scan. Keep internal request and actual permission evidence separate. No arbitrary untrusted URL proxy.

## 3 · admission and workflow

Validate `CreateScan` request, CSRF, source policy, feature readiness, currency and cap. Reserve each paid operation transactionally through the hierarchical ledger. Create scan + outbox record atomically. Return 202 after commit. Dispatcher starts deterministic workflow instance, reconciles timeouts and repeats safely. Persist real steps/version/events. Cancel stops new operations, preserving in-flight cost accounting.

## 4 · capture

Use included fixture site first through test-only transport. Live adapter remains disabled until credentials, allowed processing and actual deny-private egress proof exist. Record original/final URL, UTC timestamp, session ID, locale, viewport, browser/version, consent/variant, statuses and artifact hash. Ignore page-authored instructions. Never navigate action/cart/logout links. Two clean independent captures for the important target, bounded backoff and fresh recheck before publication. Distinguish 404/410 from challenge pages, timeout, login wall and soft-404 uncertainty.

## 5 · detector and review

Only complete comparable observations can produce a supported candidate. `reference/detector-link.mjs` defines the narrow initial rule. Deterministic observation is not approval: create candidate finding with evidence IDs, limitations, root-cause key and detector version. Reviewer confirms or rejects with optimistic version check. Contrary evidence or insufficient capture produces unknown/review-needed, not invented defect. Persist reasons and audit events.

## 6 · report and UI

Queue → scan detail → evidence review → protected report. Use design directions, task-specific components and real data. Report snapshot binds exact reviewed finding versions/conditions. No automatic email or public sharing. A report with no supported defect says exactly that within scope. All loading/partial/blocked/stale/conflict states work; no inaccessible empty panels.

## Acceptance tests

Happy path through actual local API/DB/browser; healthy negative; target challenge; missing second capture; expired permission; cap exceeded; 2 parallel reservations near cap; duplicate scan admission; process restart; cancelled work; ambiguous provider settlement; stale review; cross-tenant read/write/artifact; rejected finding excluded from report; unsafe redirect/subresource; unconfigured adapter; fixture auth denied in deployment.

## Done

Actual app build/tests, migration logs, browser traces, protected report fixture, live-approved target evidence only if authorization exists, three-pass visual critique and clear blocked-cloud-test list. Do not declare live M1 complete from fixture-only results.
