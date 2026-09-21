# Component/state inventory

| Component | Responsibility | Must support |
|---|---|---|
| WorkspaceContext | Identify active tenant/venture and permitted switch | Long names, no unauthorized choices, sign-out, keyboard |
| CaseRow | Compare review opportunities | Unknown score, stale evidence, selected state, nested independent action |
| EvidenceStage | Inspect actual captured proof | Loading/unavailable/redacted, zoom, image dimensions, keyboard close |
| SourceStrip | Expose provenance without visual overload | Absolute time, detector/version, locale/variant/viewport, expandable details |
| FindingNarrative | Distinguish observation, interpretation and limit | Confirmed/qualitative/contrary evidence, accessible references |
| ReviewSeam | Commit a human decision on a version | Pending, reason validation, permission missing, conflict, preserved draft |
| CoverageSummary | Explain sample completeness | Complete, partial, no valid capture; not a whole-store score |
| BudgetSummary | Explain limit and actual/in-flight cost | Currency, paused, insufficient, uncertain settlement, no automatic top-up |
| ScanTimeline | Real observed job progress | Step events/retries, cancelled/blocked, no fake percentages |
| EmptyState | Explain why there is no content | Workspace empty vs filters empty vs provider missing |
| ProtectedReport | Communicate useful assessed findings | Immutable version, as-of, limitations, revocation, print |
| Notification | Confirm actual task outcome | Assertive errors sparingly, no interrupting every background step |

Specify semantic HTML, focus order, screen-reader label, keyboard input, mobile behavior, loading/error behavior and contract fields for each component. Accessible primitives may be reused; visual composition and task-specific components must be authored.
