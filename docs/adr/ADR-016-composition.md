# ADR-016 · the case composition leads with the observation matrix

**2026-09-21 · provisional**

Provisional because DESIGN_BRIEF.md reserves a broad visual freeze for owner and design
review, and because the walkthrough behind it was heuristic, not participant research.

## Problem

D0 asks for "two or three genuinely different compositions for the same populated case, not
palette variations", a selection, and a recorded rationale. The kit's `preview.html` is one
authored Evidence Desk exploration and is explicitly "a concept, not a pixel template".

## Decision

Direction **A · Agreement first** is implemented. The case screen is a three-column layout —
context rail, evidence column, claim and decision column — where the evidence column opens with
a grid: rows are the pages inspected, columns are the clean sessions, each cell is one recorded
response, and a line beneath states whether the checks agreed. Selecting a cell loads its
artifact below it and highlights the matching numbered reference in the claim column.

The reasoning is specific to this detector rather than general taste. MF-LINK-01 asserts
nothing from a single observation: its entire evidentiary weight is that two independent,
comparable, complete checks agreed. Prose can state that; a grid shows it, and shows its
absence just as plainly — a missing cell is drawn as missing, so a half-captured sample cannot
be mistaken for a smaller complete one.

Direction **B · Document first** — the written assertion at the top with captures as numbered
citations beneath — is rendered at `/design-studies` alongside A on identical content, and is
not implemented.

## Alternatives rejected

- **B · Document first.** Reads well and resembles the final report, which is its problem: the
  reproducibility that justifies the claim becomes a footnote, and comparing two sessions needs
  scrolling. Kept as a study because the *report* surface does use exactly this shape, where it
  is right.
- **Copying the kit preview's composition.** Tabs above a single stage with no comparison view,
  and a serif editorial voice. AGENTS.md forbids adopting it as a template, and it answers a
  different question than the one the detector actually turns on.

## What this is not

Not a claim of usability validation. Pass 2 was a heuristic walkthrough by the implementer, not
a user test. Direction A's own risk — that a reviewer reads the grid and skips the limits — is
unmeasured; the acknowledgement checkbox in the review seam is a mitigation, not evidence.

## Verification

`docs/design/DESIGN_LOG.md` records the three critique passes with the screenshots that back
them. Browser acceptance asserts the matrix renders four cells for a two-page scan, that the
agreement line states the shared status, and that selecting a cell loads its artifact.
