# ADR-027 · The category rubric, and building the two rules behind a lock

**Status:** accepted · 2026-09-22
**Supersedes nothing. Unblocks:** `CE-CONTENT-01`, `CE-VISUAL-01`

## Context

Four of the six Consistency Engine rules are deterministic. A link returned 404 or it did not;
an image painted or it did not; two numbers agree or they do not; something covered the
viewport or nothing did. Each of those is a fact about a recorded page, and a reviewer
confirming one is checking arithmetic.

`CE-CONTENT-01` and `CE-VISUAL-01` are not like that. "This page is missing buying information"
is not a claim about a page at all — it is a claim about _what a buyer of this kind of thing
needs_, which is a commercial judgement. A rule that decided for itself what an overshirt page
must say would be enforcing a house style on somebody else's shop under the heading of a
defect, and this system's entire value is that it does not do that.

That was the block. It was recorded for several sessions as "no rubric exists", and it was
described as a product decision that engineering could not make. That framing was half right
and it had started to function as an excuse: nobody was going to write a rubric from a blank
page, and the two rules were never going to move.

## Decision

Three parts.

**1. Draft the rubric anyway, and sign nothing.** `config/category-rubric.json` is a filled-in
rubric for one category — _apparel, everyday layers_ — written by this build. It is a proposal
to argue with, not a standard. `approval.approved_by_subject` is `null`, and stays null until
somebody has read it and stands behind it. The file carries a `$what_I_am_least_sure_about`
block naming the four judgements I trust least, and a `contested` list of five things a
reasonable colleague would disagree about, which no finding ever claims.

The category chose itself: every fixture in `fixtures/m2-server.mjs` is an "Everyday
overshirt", and both ventures that would sell a scan sell into DACH apparel. A rubric for a
category nobody here has ever inspected could not be validated against anything.

**2. Build both rules, fully tested, against that rubric.** They are not stubs. Both are pure
functions in `@oe/domain` with the same abstention discipline as the four built rules —
two independent comparable captures, every abstention named, capture integrity checked before
any judgement. They are tested against the _real_ rubric file, signed in memory, so the tests
break if the shipped patterns stop matching pages they should match.

**3. Lock them shut in the database, not in the service layer.** Migration 0017 adds
`oe.category_rubrics`, whose `approved_by` and `approved_at` are `NOT NULL`, so the table can
only ever hold approved rubrics. `oe.scans.rubric_key` is a foreign key into it, and a check
constraint requires one whenever `CE-CONTENT-01` or `CE-VISUAL-01` appears in a scan's
detector list. An unapproved rubric produces no row, so no scan can name it, so neither rule
can be requested — by the API, by the runner, or by a caller going straight to SQL.

This is the arrangement migration 0009 already uses for prices: an offer cannot be sellable
without a named approver. An unpriced SKU stays unsellable; an unsigned rubric stays unapplied.

The runtime role gets `SELECT` on `oe.category_rubrics` and nothing else. The application that
_applies_ a standard is not the application that gets to _write_ one.

## Two consequences worth stating

**"Implemented" and "requestable" have come apart.** `IMPLEMENTED_DETECTORS` stays at four and
a new `RUBRIC_GATED_DETECTORS` holds the two. They are kept separate because "not built yet"
and "waiting on a judgement somebody owes us" are different sentences to put in front of a
user, and the operator bundle needs to say the right one.

**`CE-VISUAL-01` proposes two different grades, and this is the most load-bearing decision in
it.** There is no vision model in this system and there will not be one here: a machine
asserting what a photograph shows, inside a document whose value is that every claim was
checked, would be the single worst thing this product could do. So the rule reads the only two
things a captured page discloses about its images — how many, and what the page says each one
is — and grades them differently:

- **A count below the category floor** is arithmetic over recorded evidence. Grade **A**.
- **A gap in declared coverage** ("no image is described as showing the back") rests on alt
  text, and alt text is missing or careless on plenty of pages that photograph a garment from
  every angle. The absence of a description is not the absence of a photograph. Grade **B**,
  which `checkActionReadiness` refuses to publish until a specialist has looked — and
  "specialist review" is exactly what `contracts/detectors.json` asks for on this rule.

If every image on the page carries no description at all, the rule abstains
(`shot_coverage_not_declared`) rather than reporting a shot gap. Saying "no image shows the
back" there would be describing the alt text while appearing to describe the photographs.

## What I am least confident in

Recorded here as well as in the file, because an ADR is where somebody will look:

1. **`minimum_product_images: 3`** is the weakest number in the rubric. Three — front, back,
   detail — is the conventional floor for apparel. I have not measured anything, and neither
   has anyone else here. It is a convention repeated, not a finding.
2. **`returns_window` as _required_.** A buyer will not abandon an overshirt because the
   returns window is not restated on the product page; they assume the statutory right exists,
   and in the EU it does. I kept it required because fit is the largest return driver in this
   category. Moving it to `expected` would be defensible and I would not argue hard.
3. **Linked pages discharging `size_measurements`.** I said a linked size guide counts. Someone
   who believes measurements must be on the page itself gets a very different defect rate from
   the same rubric, and the rubric still looks reasonable to them.
4. **The German patterns are mine, not a native merchant's.** A missed spelling reads as a
   missing disclosure, which is a false positive against a page that did nothing wrong. This is
   the item most likely to cause real harm and the one most cheaply fixed by someone who sells
   in German.

## What is deliberately not done

**Neither rule is wired into the scan runner.** They cannot be admitted, so a branch for them
in `workers/scan-runner/src/runner.ts` would be several hundred lines that cannot execute and
cannot be tested end to end — and this repository has already been bitten once by code that
only the e2e suite could exercise (ADR-025, the `__name` bug that made every image read as
"did not render"). Wiring is the first task after a rubric is approved, and it is small: the
observation shapes both rules consume are already produced by `@oe/capture/page-content.ts`.

**`CE-CONTENT-01` checks that a page _says something_ about a required item, not that what it
says is any good.** "Material: siehe Etikett" passes. Judging adequacy needs a reader; this is
not a reader. The limitation is carried in every finding rather than papered over.

## Alternatives rejected

**Wait for the owner to write the rubric.** The honest status quo, and it had held for several
sessions. A blank page is the hardest thing to hand somebody, and the cost of a bad draft is
low here precisely because the draft cannot be applied to anything.

**Ship the rules ungated and rely on admission.** The service layer is the right place for a
_good error message_ and the wrong place for the control. A constraint that only holds when the
application remembers to check it is not a constraint. `tests/db/category-rubric.test.ts` goes
straight to SQL for that reason.

**Let an unapproved rubric default to advisory findings.** Tempting, and wrong in the same way
a draft price defaulting to sellable would be. There is no such thing as a finding that is
"only a suggestion" once it is in a document with the customer's name on it.
