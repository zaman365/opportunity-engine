# Workflow contracts

Machine transitions live in `contracts/state-machines.json`; pure transition tests live in `reference/state-machine.*`. They are not a durable execution engine.

## Scan lifecycle

`queued → validating → capturing → analysing → succeeded | partial`. A safety/source/cap denial before useful capture becomes `blocked`; infrastructure failure after retry budget becomes `failed`. Active states may enter `cancel_requested → cancelled`. A terminal scan never restarts in place; a rerun creates a new scan with `supersedes_scan_id` and new cost authorization.

Queued means the admission transaction committed, not merely that a browser spinner started. Succeeded means the scheduled capture/detector work finished with sufficient coverage for its checks, **not** that a reviewed finding exists. `partial` requires a structured reason and actual completed/expected counts. The reviewer may approve a supported finding from a partial scan if its specific required evidence is complete and the report discloses the partial sample.

Workflows are retried; business transitions use compare-and-swap `version`. Update state and audit event together. Repeated identical command/idempotency key returns the original result. Reusing a key for changed input is 409. Different simultaneous commands on the same expected version produce one winner and one VERSION_CONFLICT. Re-read state before each paid operation and before publishing an artifact.

## Finding lifecycle

`candidate → confirmed | rejected | unknown`. `unknown → candidate` requires new evidence. `confirmed → stale | rejected`; `stale → candidate` requires revalidation. Rejected findings remain immutable audit history; a new finding can supersede them. Confirmation requires supporting evidence, reviewed limitations, no unresolved contradiction, current evidence scope and a reviewer bound to that finding version. A version change invalidates an existing report draft approval.

Technical deterministic confidence is not human confirmation. “No supported finding” is a detector result, not a fake candidate with severity zero. Evidence grade C is never a publishable defect. Grade B can appear only as a clearly separated reviewed improvement hypothesis, once M2 supports that report section; M1 customer defect reports require A-grade evidence.

## Report lifecycle

`draft → approved → published`; `draft/approved → superseded`; `published → revoked | superseded`. Create immutable snapshots of finding IDs and versions, detector/capture conditions, exclusions, customer/tenant binding and reviewer. Approval does not send mail. Publishing means creating a protected accessible report version; external delivery requires separate M3 permission. A published report never silently changes when a source row updates. Stale evidence adds a visible alert and blocks new publication until reviewed; already published history shows its as-of timestamp and can be revoked for unsafe/inaccurate claims.

## Reservation lifecycle

`reserved → settled | released | uncertain`; `uncertain → settled | released` only after reconciliation. Chargeable step begins only after atomic reservation at all applicable scopes. On cancellation stop new work; retain uncertain/in-flight reservations until provider settlement proves their status. A timeout is not proof of zero charge. An actual overrun is recorded and blocks further spend rather than hiding the cost or discarding the invoice.

## Engagement lifecycle · M3+

`draft → awaiting_acceptance → awaiting_prerequisites → ready → in_progress → awaiting_verification → accepted → closed`. Side states `change_requested`, `cancelled` and `disputed` have explicit reason/owner. No start before accepted offer version, required permissions and payment/contract prerequisites. Acceptance follows verified work plus customer/authorized owner acceptance, not a “payment succeeded” webhook. Scope change creates a new approved version.

## Publication race example

Reviewer opens finding v3; another reviewer rejects it at v4. First reviewer submits confirmation with expected_version=3. API returns 409 and fresh version; the UI preserves their typed notes but requires re-review. No last-write-wins override. Publishing report built from v3 is rejected as STALE_REVIEW.

## Retry/outbox example

DB commits scan + reservation intent + `scan.admitted` event. Dispatcher times out starting the workflow. It queries the deterministic instance ID before retrying. A repeated callback reuses event ID/step key. No duplicate scan, artifact, charge reservation or report results.
