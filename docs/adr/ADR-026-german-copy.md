# ADR-026 · The frame is translated; a confirmed claim is not

**2026-09-22 · accepted**

## Problem

The report schema has carried a `language` field since M1, and `de` was always accepted. What
it produced was an English document with a German label on it: every heading, limitation and
exclusion was hard-coded English regardless. The customer-facing page and the embedded intake
form were English-only too.

For a product whose customers are German shops, and whose whole argument is that it states
exactly what it checked and exactly what that does not prove, a document whose disclaimers are
in a language the reader may not have is not a small gap.

## Decision

**The frame is translated.** Headings, base limitations, exclusions, the "x of y pages were
captured" sentence, the invalid-link page, the form's labels. This system authors all of those,
from a fixed set, at the moment it writes the document. A German customer reads them in German.

**A confirmed claim is not translated.** A finding's claim and its limitations are the exact
text a reviewer read and put their name to, bound to a finding version in `oe.reviews`.
Translating it afterwards would produce a sentence nobody confirmed, inside a document whose
entire value is that somebody did.

So a German report carries its findings in the language they were confirmed in, above a note
that says so. That is the honest arrangement rather than a gap in it, and it is the same
principle that stops migration 0011 from rewriting `oe.findings.detector_id`: what was recorded
stays as recorded.

**Scan notes are covered by the same note.** A scan's coverage notes — "2 images referenced by
the inspected page were checked" — are written when the scan runs, before any report language
exists. They are in the same position as a claim, so the note is rendered above whichever of
the two appears first rather than only above findings.

**No machine translation anywhere near this.** A claim about somebody's shop rendered into a
language nobody checked is precisely the kind of plausible text this system exists not to
produce.

**The form speaks the site's language, and the site does not choose it.** `oe.intake_channels`
gains a `language` column, defaulting to `en` so an existing channel is unchanged. The labels
are served by `GET /public/intake/form` rather than bundled into the script — because a form
whose labels a host page could rewrite is a form whose privacy sentence a host page could
rewrite, and that sentence is the one that says asking for a check is not signing up for
anything.

The script owns exactly one string: "This form is not available right now." There is nothing to
fetch it from when fetching is what failed.

## Where each string lives

One string, one owner. `REPORT_FRAME` holds what goes into a stored report body; `PAGE_COPY`
holds what the customer-facing page renders; `EMBED_COPY` holds the form's labels. The
"nothing was found" sentence lives only in `PAGE_COPY`, because it is rendered by the page and
by the operator's report view and duplicating it into the frame would give it two places to
drift — which, for a sentence whose whole job is to stay scope-limited, is exactly the wrong
risk.

## Alternatives rejected

- **Translating confirmed claims.** The document would then contain sentences nobody checked,
  attributed to a reviewer who never read them.
- **Machine translation for the frame.** The frame is a fixed set written once. Generating it
  would add a failure mode for no benefit.
- **Letting the reader's `Accept-Language` choose.** A shared document must read the same for
  everyone who opens it; that is what makes "this is the version you were sent" true. The
  report's own language decides.
- **Letting the embedding page pass a language attribute.** Anything a host can set about this
  form is something a host can set wrongly, and the privacy sentence is not theirs to choose.
  The channel's registration decides.
- **Making `findings_language_note` a required response field.** The handoff's own example
  payloads predate it and must keep validating. Widening a response may add what a server
  sends, never remove what a client was allowed to omit.

## Affected contracts

`Report` gains an optional `findings_language_note`. `IntakeForm` gains `language` and `copy`.
`IntakeChannel` gains `language`. Migration 0016 adds the column with an `en` default and a
two-value check.

## Verification

- `tests/unit/copy.test.ts` — 10 cases, in two kinds. Mechanical: every language has every key,
  no empty strings, every `{placeholder}` survives translation — a half-finished translation is
  worse than none because it looks finished. Substantive: the German keeps the scope-limiting
  qualifier on the no-defect sentence, keeps the exclusions as refusals rather than
  reassurances, keeps "revenue was not measured", keeps "a request is not a sign-up", and
  contains no leaked English.
- `tests/integration/report-delivery.test.ts` — a German report end to end: composed, approved,
  published, shared, and read as a page with `lang="de"`, German headings, German limitations,
  the English finding under a note explaining why, and no English heading anywhere.
- `tests/integration/intake.test.ts` — an English channel and a German one serving their own
  labels, and the script proven not to contain either set.

## Status

**Accepted.** English and German. A third language is a matter of adding a column to three
objects in `copy.ts`, and the completeness tests fail until every key is present in it.
