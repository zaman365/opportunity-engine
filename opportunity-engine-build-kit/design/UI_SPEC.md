# UI and interaction specification

## Navigation and route ownership

Initial internal surfaces: `/opportunities`, `/accounts`, `/scans`, `/scans/:id`, `/opportunities/:id`, `/reports/:id`, `/settings`. M3 introduces `/engagements`; M5 introduces `/monitoring`. Do not expose dead primary-navigation destinations before their functional phase. A disabled future integration belongs in a clearly explained settings inventory, not as a blank page masquerading as a feature.

Deep links preserve account/case; list filter/sort state belongs in query parameters. Browser back returns to prior list selection/scroll. Do not create an unnecessary “dashboard” between sign-in and useful work. Initial destination is the actionable queue or honest empty state.

## Screen specifications

| Surface | Primary question | Primary action | Required contextual information |
|---|---|---|---|
| Review queue | What needs my attention next? | Open next review | Account, strongest finding, evidence state, priority interval/coverage, permission, owner, freshness |
| New scan | What exactly will be checked and what can it cost? | Confirm bounded scan | Approved target, scope, limitations, provider readiness, currency, remaining/reserved cap |
| Scan detail | What happened, and what is incomplete? | Inspect evidence / cancel new work | Real step state, completed denominator, partial/blocked reason, actual/reserved costs |
| Evidence review | Does the proof support this claim? | Confirm / reject with reason | Artifact, observation conditions, contrary evidence, claim scope, unknowns, reviewer version |
| Protected report | What did we establish and recommend? | View scoped next step | Inspected sample, as-of time, confirmed facts, hypothesis labels, exclusions, author |
| Owner settings | What authority and capacity exists? | Save explicit change | Members, roles, source policies, adapter status, limits, paused reasons, audit trail |

## Queue behavior

Use a semantic table/list suited to actual content. Columns should not all compete equally: title/account first, next action prominent, numeric score subordinate to evidence and permission. Complete scores and uncertain ranges use distinct presentation. The default sort considers actionable/fresh/reviewable work, not simply descending score. Show unknown score as an interval or “Not scored,” never 0%. Search is debounced but local filtering can be immediate; provide clear filters and empty results separate from empty workspace.

Row activation cannot swallow links/buttons inside it. Expose a named button/link for the case; support focus and keyboard. Selection styling does not rely only on background tint. Persist filters across route changes. Do not cram columns below readable width; use priority layout or a labelled horizontally scrollable table while keeping essential actions accessible.

## New scan

Approved account selector, target URL, scope summary, detector selection limited to enabled pack, captured-page limit, price/cap snapshot and permission context. M1 restricts targets to previously approved exact hosts. Currency is adjacent to amount. Confirm requires ready provider, allowed scope and sufficient cap; give the specific missing prerequisite. Do not show a non-working submit as “coming soon.” Preflight errors are inline and summarized. After admission navigate to actual scan ID; preserve an idempotency key across network retry, and do not create a second scan because the response timed out.

## Evidence review

Keep artifact and assertion visible together on wide screens. At narrow width use Evidence / Finding / Decision tabs or an ordered accordion, retaining unsaved notes. Artifact opens a labelled zoom viewer with escape/focus return. Original resolution and capture context remain available; don't blur authentic evidence for aesthetic effect. Annotation coordinates are relative to the actual image dimensions and version, never model-invented hotspots.

Show source, capture time, viewport, locale, variant, consent state and detector/version progressively. A compact source strip should reveal details without a trip to another page. Label contrary evidence and unresolved context explicitly. Reviewer reason is required on rejection; confirmation acknowledges scope/limitations. Review command binds expected version. If conflict, preserve notes, show updated state, require re-review. No optimistic “approved” until server acknowledgement.

## Reports

Do not render a dashboard as a customer report. Use an editorial assessment: title/scope → strongest reviewed facts → evidence references → recommendations with exclusions → next step. Separate technical defects from reviewed qualitative improvements. Clear as-of and reviewer identity. Publish immutable version; revoked link shows a neutral unavailable message without leaking tenant/customer data. No public index; no report tracking pixel by default. Print style omits navigation while preserving limitations and provenance.

## Required state behavior

| State | Show | Action |
|---|---|---|
| Empty workspace | No scans yet; explain bounded inspection | Create approved scan |
| Empty search | Query/filter explanation | Clear filters |
| Loading | Real operation label; stable structure | Cancel only when supported |
| Partial | Completed/expected sample and reasons | Inspect complete checks, rerun with new authorization |
| Blocked | Source/safety/budget/configuration cause with no misleading findings | Correct prerequisite / owner review |
| Evidence unavailable | Metadata and why image cannot be shown | Re-capture if permitted |
| Stale | As-of date and review invalidation | Revalidate |
| Conflict | Updated version, preserved typed note | Re-review; no overwrite button |
| Provider missing | Not configured, owner instruction | Setup—not sample data |
| No supported defect | Scope-limited result | Finish review, not universal “healthy” |
| Cancellation pending | No new work; in-flight cost may remain | View settlement status |
| Success | Specific completed operation | Next useful step, no generic celebration |

## Copy and formatting

Operator English initially. Customer report English/German. Use locale formatting for display but store UTC timestamps and canonical numbers. Full timestamps show timezone; relative dates expose absolute values. German text can expand 30–40% in fixtures; do not assume the expansion percentage is a universal measurement. Use tabular numerals for aligned cost/score columns. Whole euros can display naturally; provider micro-costs need suitable precision and clear currency, never six zeros everywhere.

## Responsive contract

At 1440: clear queue/workbench with a generous artifact stage. At 1024: condense secondary columns and metadata. At 768: recompose into a focused case flow. At 390/320: no clipped decision controls or mandatory side-by-side review. Test 200% zoom and reduced motion. Sticky regions must not obscure focused items or consume most of a small viewport.

## Interaction invariants

No action-looking element is inert. Disabled actions have an accessible reason. No card click competes with hidden nested buttons. Escape closes temporary layers and restores focus. The back button works. Tab order follows task order. User notes are not discarded on view changes. Destructive/irreversible operations require explicit wording; rejection remains an auditable review decision, not record deletion.
