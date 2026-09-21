# M2 · Consistency detectors

**2 of 6 built.** Supersedes `opportunity-engine-build-kit/tasks/M2_DETECTORS_AND_OFFERS.md`.
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

`CE-DATA-01`. It reuses the existing capture port, evidence model, review path and report
composer unchanged — which is the point of having built two detectors end to end first.
