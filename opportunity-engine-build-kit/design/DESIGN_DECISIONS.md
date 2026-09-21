# Design decision record

## D-001 · provisional reference direction

**Status:** authored concept supplied with kit; not a user-validated final design.

Evidence Desk is the initial direction: neutral near-white workspace, strong editorial heading, case-list comparison, a broad evidence stage, numbered provenance and an in-context decision strip. It avoids decorative KPI blocks and uses screenshots as working material. The preview's system fonts keep it self-contained; they are not a mandate for the final type system.

Tradeoff: editorial character can consume vertical space. The production designer must tune the queue/workbench density on real data and prove quick sequential review. Alternate compositions B/C are described in DESIGN_BRIEF.md and must be explored during D0; the kit does not claim they were implemented or tested with users.

## Review log

The kit's actual preview inspection results are recorded in VERIFICATION.md. Future entries: date, concept, screen/scenario, screenshot path, reviewer type (human user / designer / heuristic agent), finding, change, remaining uncertainty.

## Template

Decision ID; status; problem; alternatives; chosen expression; task/accessibility evidence; rejected effects; token/component changes; actual user feedback or clearly labelled heuristic observations; approval/provisional owner.


## Handoff prototype critique record

These were authoring/heuristic passes, not participant research or a production accessibility audit.

**Composition:** the first rendered Evidence Desk uses a case index, artifact stage and interpretation column, rather than a dashboard KPI grid. The evidence image receives the primary area; explanation is separated into observation, hypothesis and limitations. The serif title is provisional, not a mandatory brand font.

**Task walkthrough:** exercised filtering, missing evidence, local confirmation/rejection, required reason, report gating, dialogs and reset. Screenshots exposed a long mobile queue ahead of the evidence. Revised the narrow-screen queue to a collapsible index; selecting a case returns focus to its detail. No live action is simulated.

**Craft revision:** increased provenance/helper text, made selected evidence controls clearer, specified “Destination response” to avoid implying the source page is a 404, and increased mobile control targets. Re-ran the interaction checks and inspected desktop/narrow layouts. Full keyboard/assistive technology, WCAG conformance and user validation remain M0/M1 acceptance work.

Only territory A is rendered here. The designer/coding tool must still compare two genuine compositions at M0; do not describe B/C as implemented or user-tested.
