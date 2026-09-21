# Definition of done and acceptance matrix

## Three separate claims

**Reference verified:** pure logic and kit contracts pass tests. **Application verified:** actual routes/database/providers/browser flows pass their environments' tests. **Production released:** owner-authorized deployment passes live smoke/security/restore checks. Never collapse these into one “complete” badge.

| Area | Required proof |
|---|---|
| Contract | Request/response examples validate; invalid states and unexpected properties rejected |
| Persistence | Restart/resume preserves scan, evidence, reviews and reservations |
| Tenant isolation | Two real DB connections/roles cannot read/write/link each other's objects |
| Auth | Missing/expired/wrong-audience/revoked assertions fail; no header trust or fixture bypass |
| Workflow | Duplicate delivery and retries create one business effect; cancellation retains uncertain costs |
| Network | Private target, redirect, subresource and rebinding cases blocked by actual egress boundary |
| Detector | Known positive + healthy negative + blocked/incomplete/variant fixtures with recorded evidence |
| Review | Stale version returns conflict; contradictory evidence blocks confirmation |
| Report | Immutable snapshot, protected audience, explicit scope/as-of/unknowns, no unsupported revenue claims |
| Budget | Parallel DB reservations preserve caps; uncertain and overrun settlement tested |
| UI | Actual keyboard/mobile/error-state testing; screenshots and critique, no generic filler panels |
| Operations | Backups restored, migrations rehearsed, rollback documented, logs redacted |

## Detector evaluation

Track precision, missed cases and abstention separately by detector/category/platform. Hold out examples not used for tuning. Include healthy pages, disabled features, consent overlays, lazy loading, region changes and challenge pages. 90% is a proposed precision target, not a claim inferred from ten examples. Record sample counts, reviewer disagreement and limits. A detector that abstains on most pages can have high precision but low usefulness; measure both.

## UI test scenario set

Authenticated initial empty workspace; 2 and 200 opportunities; long German names and URLs; partial scan; no evidence; evidence expired; conflicting reviewer update; cap blocked; provider unconfigured; tenant switch; rejected finding; report with zero supported defects; redacted artifact; network loss during a decision; narrow mobile at 390/320; wide 1440; keyboard-only; zoom 200%; reduced motion.

## Release statement template

Implemented features; environments tested; exact commands/results; omitted/skipped tests; known limitations; authority obtained; deployment identifier; migration version; rollback route; owner. Never state “all tests pass” without identifying which test suites exist and ran.
