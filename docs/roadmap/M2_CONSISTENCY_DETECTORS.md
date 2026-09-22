# M2 · Consistency detectors

**4 of 6 built.** Supersedes `opportunity-engine-build-kit/tasks/M2_DETECTORS_AND_OFFERS.md`.
The offer half of that document is [M4](M4_OFFERS_AND_SERVICE_SCOPE.md) now; it is already
built, and it was never really a detector milestone.

| Detector        | Rule                                                | State                                       |
| --------------- | --------------------------------------------------- | ------------------------------------------- |
| `CE-LINK-01`    | An informational link returns a repeated 404/410    | **Built**, negative controls in place       |
| `CE-ASSET-01`   | A product image fails to load _and_ fails to render | **Built**, four abstentions covered         |
| `CE-DATA-01`    | Structured data and the visible page disagree       | **Built**, eleven abstentions covered       |
| `CE-MOBILE-01`  | Something covers the page at a phone viewport       | **Built**, thirteen abstentions covered     |
| `CE-CONTENT-01` | Category buying information not stated              | **Built**, locked behind an approved rubric |
| `CE-VISUAL-01`  | Image sequence fails the category rubric            | **Built**, locked behind an approved rubric |

`IMPLEMENTED_DETECTORS` drives the request contract, admission and the database constraint, so
a detector cannot become requestable in one layer and not another. `CE-CONTENT-01` and
`CE-VISUAL-01` sit in a second list, `RUBRIC_GATED_DETECTORS`: written and tested, and unable
to run until an owner signs a category rubric. "Not built yet" and "waiting on a judgement
somebody owes us" are different sentences to put in front of a user.

## What a detector owes

Set by [ADR-017](../adr/ADR-017-asset-detector.md) and not negotiable per detector:

- **Two independent comparable sessions must agree.** One observation is an anecdote.
- **Every abstention is named and has a fixture.** `blocked`, `pending_lazy_load`,
  `decorative_image` and `variant_changed` each have a route and a test. A detector that
  cannot say "I don't know" will eventually say something false instead.
- **A known positive and a healthy negative control**, both as held-out fixtures.
- **The claim is an observation.** What it might mean is separate, labelled a hypothesis, and
  chosen by detector rather than written once and reused.

## Next

The block on the last two rules was never code. `CE-CONTENT-01` and `CE-VISUAL-01` apply a
**category rubric** — what a buyer of _this kind of thing_ needs a page to tell them — and that
is a commercial judgement, not a property of markup. A rule that decided it for itself would
assert taste as defect.

So the rubric was drafted rather than waited for. `config/category-rubric.json` is a filled-in
proposal for one category (apparel, everyday layers), written by the build, **unsigned**. Both
rules are built against it and both are held shut by migration 0017: `oe.category_rubrics` can
only hold approved rubrics, and a scan naming either rule must name one. An unsigned rubric
produces no row, so neither rule can be requested — including by a caller that goes straight
to SQL.

**What unblocks them is one act: somebody reads the rubric and signs it**, or edits it and
signs that. The file names the four judgements the draft is least sure of. See
[ADR-027](../adr/ADR-027-category-rubric.md).

Then two things follow, in order: load approved rubrics in the seeder the way the offer
catalogue is loaded, and wire both rules into `workers/scan-runner`. The observation shapes
they consume are already produced by `@oe/capture/page-content.ts`.

`CE-DATA-01` left one thing undone: a price that only exists after JavaScript has run is
invisible to it, because the capture path deliberately does not execute page scripts. See
[ADR-024](../adr/ADR-024-data-detector.md). `CE-MOBILE-01` has the same shape of limitation for
script-injected overlays — see [ADR-025](../adr/ADR-025-mobile-detector.md).
