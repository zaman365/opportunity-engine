# ADR-025 · CE-MOBILE-01, and the bug that made healthy images look broken

**2026-09-22 · accepted**

## Problem

`contracts/detectors.json` specifies the fourth detector: "Actual obstruction at recorded
viewport with DOM/image evidence and repeated state", abstaining on
`user_dismissible_overlay_not_tested`, `transient_loading` and `missing_viewport`.

Building it turned up a second, worse problem in the capture path — described at the end,
because it is the more important half of this record.

## Decision · the detector

**An obstruction is not "there is a sticky bar".** Almost every site has one. It is an element
that covers at least a quarter of the viewport _and_ overlaps at least a tenth of the page's
own content region. A 48-pixel header on an 844-pixel screen is 6% and is furniture. The
threshold is deliberately generous to the page: being wrong that way misses a real obstruction,
and being wrong the other way tells a shop their normal header is a defect.

**Only what is on screen counts.** An element hanging off the bottom obstructs the part of it
that is visible, not its own height.

**The same element, both times.** Matched by a key built from tag, id and first three classes —
stable enough to identify the same element across sessions, meaningless enough to carry no page
content. Something seen once produces `obstruction_not_repeated`, which is a different answer
from "nothing covered it" and says so.

**A phone, or nothing.** Above 480 CSS pixels this is not "obstruction at a phone viewport",
so the rule declines rather than reporting a desktop measurement under a mobile heading.
Requesting it adds a second pair of captures at 390×844 — the same page at another screen
size, which does not enter the coverage denominator but does get its own evidence, at session
ordinals 3 and 4 so it sits beside the desktop capture rather than colliding with it.

**Dismissible means unknown.** An overlay carrying a visible close control might vanish on the
first tap. This rule taps nothing, so it says it cannot tell.

### What this rule cannot see, stated in every finding

The capture path runs with JavaScript disabled, deliberately: a captured page must not
execute. **Most real interstitials — consent managers, chat widgets, app-install prompts — are
injected by scripts and are invisible to this rule entirely.** What it sees is what the server
sent: CSS-positioned bars and overlays in the initial HTML, a real and common category but far
from all of them.

That is a limitation of the rule rather than a bug in it, and enabling scripts to fix it would
mean executing an untrusted page — which the whole capture design refuses, for reasons that
have not changed.

## The bug this work exposed

While wiring the detector, every image on every page started reading as **"did not render"**.
The cause:

> `render_failed: ReferenceError: __name is not defined`

The new layout measurement ran inside the page, and declared two named inner arrow functions.
The bundler rewrites named function expressions to call its own `__name` helper — which does
not exist in the page. The whole render threw, so no image was ever marked as painted.

Three things make this worth recording rather than just fixing:

1. **The failure produced a plausible-looking result.** Not an error a user would see: a grid
   of images all reporting "did not render". A false positive manufactured by the measuring
   instrument, on the exact claim the detector exists to make.
2. **Only one test suite could catch it.** The integration suite runs under a bundler that does
   not inject the helper, so it passed throughout. Only the browser suite, which runs the API
   under `tsx`, failed.
3. **It was invisible until something looked at a healthy image.** Every test asserting a
   _broken_ image still passed, because a broken image and a broken renderer produce the same
   answer.

Fixed by writing the in-page code with no named inner functions, with a comment saying why.
The browser suite now asserts explicitly that the render succeeded — screenshot evidence exists
and its artifact is retrievable — so a recurrence fails on the cause rather than on a symptom
three assertions later.

### And the flakiness it explains

The same work replaced the renderer's fixed 500 ms settle wait with a bounded poll for every
image request to _settle_ — `complete` is true for a failed request as well as a successful
one, so this waits for an answer rather than for success, and the deadline preserves the
bounded lazy-load semantics.

That fixed-interval wait is the most likely cause of the intermittent browser-suite failures
recorded three times in PROGRESS.md: enough on an idle machine, not always enough on a busy
one. Since the change the suite has run clean twice in a row and dropped from roughly 80
seconds to 48. Stated as the probable cause rather than a proven one — the failures were never
reproducible on demand, which is exactly why they went unexplained for so long.

The poll uses `evaluate` rather than `waitForFunction`, because this context disables
JavaScript and `waitForFunction` polls from inside the page: it silently never fires, which is
a worse failure than the one being fixed. That was found the same way — by trying it.

## Alternatives rejected

- **Flagging any fixed-position element.** Wrong on nearly every site in existence.
- **Enabling JavaScript so injected overlays are visible.** It would mean executing an
  untrusted page. The limitation is recorded instead.
- **Treating a dismissible overlay as a defect.** It might close on the first tap, and this
  rule does not tap.
- **Reusing session ordinals 1 and 2 for the phone capture.** Collides with the desktop
  capture's evidence, which is how this was discovered — a unique constraint, doing its job.
- **Counting the phone capture as a second page.** The same page at another screen size is one
  page seen twice.

## Affected contracts

`CreateScan.detectors` accepts `CE-MOBILE-01` and `PDP-MOBILE-01`, `maxItems` follows the
implemented count, and migration 0015 moves the database allowlist in the same commit as the
rule, its fixtures and its tests.

`PageObservation` gains `layout`: the overlays a page positioned over itself and the region its
content occupies, null when no renderer ran — so the detector abstains rather than reading "not
measured" as "nothing there".

## Verification

- `tests/unit/detector-mobile.test.ts` — 18 cases: the known positive, a 48-pixel sticky header
  ignored, a large element beside the content ignored, an element clipped to the viewport, all
  three contract abstentions, a desktop viewport declined, an obstruction seen once, and two
  different elements one each time.
- `tests/integration/mobile-detector.test.ts` — 8 cases through the real API and real Chromium
  layout against four new fixture routes, including that the phone view is captured as its own
  evidence at its own viewport and does not count as another page.
- `tests/e2e/operator.spec.ts` — the render-succeeded assertion described above.

## Status

**Accepted.** Four of six detectors built. `CE-CONTENT-01` and `CE-VISUAL-01` remain specified
and unrequestable: both turn on a category rubric — what a buyer of a particular kind of thing
needs to see — and no such rubric exists. Writing one is a product decision before it is an
engineering task, and writing it badly produces a detector that asserts taste as defect.
