# M2 · Consistency detectors

**3 of 6 built.** Supersedes `opportunity-engine-build-kit/tasks/M2_DETECTORS_AND_OFFERS.md`.
The offer half of that document is [M4](M4_OFFERS_AND_SERVICE_SCOPE.md) now; it is already
built, and it was never really a detector milestone.

| Detector        | Rule                                                | State                                 |
| --------------- | --------------------------------------------------- | ------------------------------------- |
| `CE-LINK-01`    | An informational link returns a repeated 404/410    | **Built**, negative controls in place |
| `CE-ASSET-01`   | A product image fails to load _and_ fails to render | **Built**, four abstentions covered   |
| `CE-DATA-01`    | Structured-data inconsistency                       | Specified, unrequestable              |
| `CE-CONTENT-01` | Product-page content gaps                           | Specified, unrequestable              |
| `CE-VISUAL-01`  | Visual consistency                                  | Specified, unrequestable              |
| `CE-MOBILE-01`  | Mobile rendering                                    | Specified, unrequestable              |

One list drives the request contract, admission and the database constraint, so a detector
cannot become requestable in one layer and not another.

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

The three remaining rules are different in kind from the three built. `CE-LINK-01`,
`CE-ASSET-01` and `CE-DATA-01` are deterministic: a 404 is a 404, an image painted or it did
not, two numbers match or they do not. `CE-CONTENT-01`, `CE-VISUAL-01` and `CE-MOBILE-01` all
turn on a **category rubric** — what a buyer of _this kind of thing_ needs to see — and no such
rubric exists.

Writing one is a product decision before it is an engineering task, and writing it badly
produces a detector that asserts taste as defect. That is the work that unblocks them, and it
is not code.

`CE-DATA-01` also left one thing undone: a price that only exists after JavaScript has run is
invisible to it, because the capture path deliberately does not execute page scripts. See
[ADR-024](../adr/ADR-024-data-detector.md).
