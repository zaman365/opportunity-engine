# Design log · operator interface

**2026-09-21 · provisional.** Every screenshot in `screenshots/` is a capture of the running
application against a synthetic loopback fixture — the kit's site for MF-LINK-01, this
repository's `fixtures/m2-server.mjs` for MF-ASSET-01. None of them shows a real merchant, no
image in them is a photograph of a real product, and none of the observations in them is
evidence about anybody's shop.

Reviewer type throughout: **heuristic walkthrough by the implementer**. No participant research
was conducted, and no WCAG audit was performed. QA.md's rubric is scored below as an internal
heuristic, not an objective measurement.

## D0 · composition studies

Both directions render at `/design-studies` on identical content: the same account, the same
two-session MF-LINK-01 result, the same limits.

|                        | A · Agreement first               | B · Document first                 |
| ---------------------- | --------------------------------- | ---------------------------------- |
| Opens with             | The grid of recorded observations | The written assertion              |
| Evidence is            | The subject                       | A numbered citation                |
| Comparing two sessions | One glance across a row           | Scrolling between citations        |
| An incomplete sample   | A visibly empty cell              | An absent citation                 |
| Risk                   | The grid reads as the whole story | Reproducibility becomes a footnote |

Screenshots: `study-a-agreement-first.png`, `study-b-document-first.png`.

**Selected: A.** Rationale and rejected alternatives in
[ADR-016](../adr/ADR-016-composition.md). B's shape is used for the _report_ surface, where the
reader is being told a conclusion rather than testing one.

## Tokens

`apps/operator/src/styles/tokens.css` was extracted from the selected composition, not adopted
from the kit's concept. Deliberate differences from `design/tokens.css`:

- **No serif display voice.** The kit preview uses Georgia for case titles. This interface
  carries authority through alignment, weight and the monospace treatment of identifiers,
  status codes and amounts, so that numbers line up in columns where they are compared.
- **Cooler, slightly darker rules** (`#dfe4e9` / `#b6bfc9`) because the grid needs visible cell
  boundaries without heavy borders.
- **Status surfaces added** (`--confirmed-surface` and siblings) because chips sit inside dense
  rows where a foreground colour alone is not enough separation.
- **Almost-square work surfaces**: 4px on controls, 6px on panels. Roundedness is not the
  concept.

Every chip carries a glyph (`✓ ! ✕ ?`) as well as a colour and a word, so status survives
greyscale and colour-vision differences. Selection is an inset edge plus weight, never a tint
alone.

## Pass 1 · composition

_1440×960, populated case, logo hidden._

The screen is recognisable as an evidence-review tool without branding: a comparison grid, an
artifact, an observation column, a decision strip. The artifact gets the largest continuous
area on the screen.

**Found and fixed**

1. **The inspected-page row read "Not captured" on a complete scan.** The case was drawing the
   matrix from the opportunity payload, which carries only the evidence a _finding cites_ — for
   this detector, the two destination checks. A page that was captured and found healthy is
   part of the sample and has to be visible as part of it. The case now draws the grid from the
   scan's own timeline. (`CaseRoute.tsx`; compare the current
   `desktop-case-evidence.png` against the failure described here.)
2. **Evidence spanning several scans in one grid.** One opportunity groups every finding that
   shares a root cause, so a case can hold findings from different scans. Mixing their sessions
   into one grid would be exactly the confusion the grid exists to prevent. The grid is now
   scoped to the selected finding's scan, and a picker appears when a case holds more than one
   finding, ordered so that work needing a decision comes first.

## Pass 2 · task usability

_Heuristic walkthrough: queue → case → evidence → decision → report, keyboard only, then at
1440, 1080, 768, 390 and 320px._

Confirmed working, with browser assertions behind each:

- The confirm action is disabled until a note of at least five characters exists _and_ the
  limits are acknowledged; each disabled state states its reason in its title.
- A conflicting decision from another session returns `STALE_REVIEW` and the typed note
  survives, with the current version named (`desktop-review-conflict.png`).
- Tab from the top reaches the skip link first. Enter on "Enlarge" opens the labelled viewer;
  Escape closes it and returns focus to the control that opened it
  (`desktop-keyboard-focus.png`).
- At 390px the case becomes four tabs — Context, Evidence, Finding, Decision — rather than a
  compressed three-column layout, and the decision controls stay reachable
  (`narrow-case-evidence.png`).

**Found and fixed**

3. **A false "ambiguous" label on a valid observation.** The soft-404 heuristic matched a bare
   `404` anywhere in the body, so the product fixture — whose own copy says "the information
   link deliberately returns HTTP 404" — was flagged as presenting itself as not-found. A
   wrong abstention is not harmless caution: it silently discards a valid check. The rule now
   requires not-found phrasing and reads only the title and headings, where a real soft 404
   announces itself. Regression cases in `tests/unit/capture-heuristics.test.ts`.
4. **Coverage wording assumed the destination.** The reason line said "The destination answered
   200…" regardless of which page it described. It now names the page it refers to.
5. **Per-scan cost limits flooded Settings.** Every admission creates a scan-scoped cap, so the
   owner's two ceilings were buried under fifteen rows. Settings now shows the workspace and
   venture ceilings and summarises how many scan-scoped limits exist; each one appears on its
   own scan record, where it means something.

## Pass 3 · craft and distinctiveness

_1440×960 and 390×844, alignment, truncation, numerals, focus._

**Found and fixed**

6. **The report's condition table wrapped a timestamp across four lines.** The timezone suffix
   on every row was the cause. Rows now use a compact local rendering with the timezone named
   once beneath the table and the UTC value in each cell's `title`.
7. **The body hash competed with the report's as-of line.** Moved to its own line with what it
   means — this version cannot change once published — rather than a bare hex fragment.
8. **Queue columns wrapped at 1440.** Next-action and score columns widened; the narrow
   breakpoints were re-checked.
9. **Evidence references appeared in recording order** (`E2.2` before `E2.1`). Sorted by their
   grid reference.

**Differences from a generic dashboard, stated plainly:** no KPI tiles, no chart, no progress
percentage anywhere — the scan timeline shows real step events and the coverage figure is a
fraction with reasons. Status colour appears only on chips and cell numerals, never as a card
tint. There are at most two surface levels per screen. Every disabled control states why.

## Pass 4 · MF-ASSET-01 in the same composition

_1440×960 and 390×844, a broken product image on the M2 fixture site._

The grid generalised without a new layout: rows now come from the evidence rather than a fixed
list, so a scan that inspected a page and two images shows three rows and six cells. The
finding's own target leads, and an image row states what the classifier decided, because the
rule turns on that. Screenshots: `desktop-case-asset.png`, `narrow-case-asset.png`,
`desktop-scan-asset-decorative.png`.

**Found and fixed — all three were truthfulness bugs, not polish**

10. **The banner still read "MF-LINK-01 only · other detectors not enabled"** while a second
    detector was running. It now renders `session.implemented_detectors`, which the _server_
    supplies, so a stale bundle cannot advertise a capability the deployment lacks.
11. **The interpretation paragraph was written for a broken link and shown on every finding.**
    A broken-image case read "A linked information page that does not load can interrupt a
    buying decision." That is exactly the interpretation-drifting-from-observation that
    BUILD_SPEC.md §8 separates the two to prevent. It is now chosen by detector, with a
    fallback that says no interpretation has been written rather than borrowing another one.
12. **The report title and next step assumed a link.** "…· inspected information links" and
    "the specific link repair described above" on a report that might carry image findings,
    link findings or neither. Both are neutral now, and the base limitation names assets.

A fourth, caught by the browser suite rather than by eye: importing the detector list from
`@oe/domain` pulled `node:net` into the operator bundle and broke every page at runtime.
The list now travels over the wire, and an ESLint rule forbids `@oe/domain`, `@oe/db`,
`@oe/capture`, `@oe/evidence` and `node:*` imports in anything the browser bundle ships.

**Still generic where it should be:** the interpretation map is a two-entry switch. It will not
scale to six detectors, and at that point the text belongs with the detector definition rather
than in the view. Noted, not done.

## Rubric · internal heuristic, 1–5

| Dimension               | Score | Note                                                                                            |
| ----------------------- | ----- | ----------------------------------------------------------------------------------------------- |
| Task clarity            | 4     | Queue → case → decision → report reads in one pass.                                             |
| Evidence readability    | 5     | The artifact holds the largest area; provenance expands in place.                               |
| Uncertainty honesty     | 5     | Interval scores, explicit limits, abstention wording, no revenue claim.                         |
| Accessibility           | 4     | Focus, names, keyboard and non-colour status verified in-browser. A full audit is outstanding.  |
| Responsive continuity   | 4     | Case and decision reachable at 390px; 320px checked by hand, not asserted.                      |
| Distinctive composition | 4     | The matrix is specific to what this detector proves.                                            |
| Typography and craft    | 4     | Tabular numerals where values are compared; pass-3 fixes applied.                               |
| State completeness      | 4     | Empty, filtered-empty, loading, partial, blocked, unavailable, conflict and revoked all render. |

No dimension below 4, so the internal bar for a provisional freeze is met. That is a heuristic
score; real user testing can invalidate it.

## Screenshot set

Generated by `npm run test:e2e` into `screenshots/`. Desktop is 1440×960, narrow is 390×844.

| File                                                          | Scenario                                 |
| ------------------------------------------------------------- | ---------------------------------------- |
| `desktop-queue.png`, `narrow-queue.png`                       | Populated queue, interval score, filters |
| `desktop-case-evidence.png`, `narrow-case-evidence.png`       | Selected observation and artifact        |
| `desktop-review-seam.png`, `narrow-review-seam.png`           | Decision strip, enabled                  |
| `desktop-report.png`, `narrow-report.png`                     | Published report                         |
| `desktop-scan-blocked.png`, `narrow-scan-blocked.png`         | Access challenge, no finding             |
| `desktop-review-conflict.png`                                 | Version conflict with the note preserved |
| `desktop-artifact-unavailable.png`                            | Artifact missing, observation intact     |
| `desktop-settings.png`, `narrow-settings.png`                 | Cost limits and absent capabilities      |
| `desktop-new-scan-blocked.png`, `narrow-new-scan-blocked.png` | Unapproved host refused before submit    |
| `desktop-keyboard-focus.png`                                  | Visible focus on the artifact control    |
| `study-a-agreement-first.png`, `study-b-document-first.png`   | D0 compositions                          |

## Still open

- Owner and design review before any broad visual freeze.
- A real accessibility audit, including screen-reader passes. The automated checks cover
  accessible names, focus return and non-colour status only.
- Participant testing. Every judgement above is the implementer's.
- An empty-workspace queue screenshot: the seeded fixture always has an account, so the empty
  state is exercised by the filtered-empty path and by reading the component, not by a capture.
- German copy at length. The report template supports `de`, but no German report has been
  rendered or reviewed.
- Density on a long queue. The queue has been seen with a handful of cases, not 200.
