# ADR-024 · CE-DATA-01 abstains wherever tax, currency or variant could explain a difference

**2026-09-22 · accepted**

## Problem

`contracts/detectors.json` specifies the third detector: "Visible and structured facts differ
for matched variant/currency/tax/stock state", abstaining on `variant_unknown`,
`multi_currency`, `aggregate_offer` and `unavailable_variant_context`.

This rule is different in kind from the two already built. A broken link and a missing image
are defects on their face — nobody argues that a 404 was intended. A price disagreement is
not: a page may legitimately show gross while its markup declares net, show one variant while
marking up a range, or quote a second currency for convenience. Every one of those looks
exactly like a contradiction to a naive comparison.

So the failure mode that matters is a false positive telling a shop their store contradicts
itself when it does not — and there is a large population of real German shops where the naive
version of this rule would do precisely that.

## Decision

**Every ambiguity resolves to an abstention.** Eleven reasons, four of them from the contract
and seven more this rule needs. The ones that carry the weight:

**Tax.** A difference is only a candidate when both sides declare the same tax basis, or when
neither declares one and the gap is larger than any EU VAT rate could produce. The ceiling is
Hungary's 27%, and the boundary is asserted to the cent: 27.00% abstains, 27.01% does not.
Being wrong in this direction costs a finding; being wrong in the other costs somebody's
trust.

**Currency.** Two ways to fail, both refused: the two sides priced in different currencies,
and more than one currency anywhere in the visible page. The second matters because a page
quoting "approx. CHF 84" beside a EUR price is ambiguous even when each figure alone is not.

**Aggregate offers.** An `AggregateOffer` is reported as such rather than flattened to its
`lowPrice`. A range across variants has no single figure to compare, and flattening it is how
this rule would tell a shop its prices contradict when they simply vary.

**Two prices in one element.** A struck-through old price beside a new one produces _no_
price, not the first one. Which one a shopper acted on is unknowable, and picking would be a
guess with somebody's name on it.

**What the rule deliberately does not do.** It does not compare the markup's SKU to the page's
visible variant label. `JKT-MED-NAVY` against "Medium" is two naming systems; a literal
comparison would abstain on almost every real page while catching almost nothing. What it
requires instead is that a variant was selected and that both sessions saw the same one. A
page marking up a different variant from the one it displays is therefore a defect this rule
does not detect — written into its limitations, not papered over with a string match that does
not work.

**"Stock not stated" is its own reason.** A page that never says whether something is in stock
is not contradicting its markup. Giving that its own abstention rather than folding it into
`unavailable_variant_context` means a reader learns which of the two sides went quiet instead
of being sent to look at variants.

## Reading the two statements

**Structured** is JSON-LD only — `<script type="application/ld+json">`, read through `@graph`
and nested `offers`. Malformed JSON-LD is skipped rather than reported: it is common, and it
is not the defect this rule is about.

**Visible** is the text of an element the page itself marks as a price, by `class`, `id`,
`data-testid` or `itemprop`. Not "the first number that looks like money" — guessing which
number on a page is the one that matters is how a wrong guess becomes a false accusation.
When no such element exists, the price is reported absent and the rule abstains.

Both are read from the recorded HTML rather than a live DOM, for the same reason the renderer
disables JavaScript: nothing in a captured page should run. **A price that only exists after a
script has run is invisible to this rule**, which is a real limitation and is stated as one.

Amount parsing takes exactly one number token or nothing. `1.234,56` and `1,234.56` both parse
— the last separator with two digits after it is the decimal one — while `49,0`, `49.0000` and
`1.2.3` produce null rather than a number that is wrong by a factor of ten.

## Alternatives rejected

- **Flattening an aggregate offer to its low price.** Convenient, and wrong on every shop that
  sells one product in four sizes.
- **Reporting a net-versus-gross difference as a defect.** It is the commonest legal
  arrangement in Europe.
- **Taking the first price-looking number on the page.** A guess wearing a measurement's
  clothes.
- **Comparing markup SKU to the visible variant label.** Abstains on almost every real page;
  catches almost nothing.
- **Extracting from a live DOM so JavaScript-rendered prices are visible.** It would mean
  running a captured page's scripts, which the whole capture design refuses. The limitation is
  recorded instead.
- **Reporting which figure is correct.** The rule cannot know. Its first limitation says so,
  and a test asserts that sentence is there.

## Affected contracts

`CreateScan.detectors` widens to accept `CE-DATA-01` and `MF-DATA-01`, and its `maxItems`
becomes the implemented count rather than a literal — so the bound moves with the list rather
than needing to be remembered. Migration 0014 moves the database allowlist in the same commit
as the rule, its fixtures and its tests, which is the point of having the constraint at all.

`contracts/detectors.json` in the handoff is unchanged: it already specifies this detector,
and shipping it is what `status: specified_not_implemented` was waiting for.

## Security and cost

No new egress and no new provider call: the rule reads a page the scan already captured, and
images and markup are both subresources of it. No extra page enters the coverage denominator.

One thing worth naming: this detector reads and stores what a page says about prices. That is
commercial information about somebody's business, held under the same purpose permission and
the same tenant boundary as every other observation — and it is one more reason the
authorization model matters rather than a new exception to it.

## Verification

- `tests/unit/detector-data.test.ts` — 26 cases. Both positives, the healthy negative, every
  contract abstention, the VAT boundary asserted to the cent in both directions, sessions that
  disagree about what disagreed, and a shape assertion that an abstention never carries a
  claim or a grade.
- `tests/unit/product-facts.test.ts` — 20 cases on the parsers: both decimal conventions,
  thousands groups, ambiguous separators refused, two prices in one element refused, currency
  by code and by symbol, tax phrases in German and English, `@graph` traversal, malformed
  JSON-LD skipped, script content excluded from what a person saw.
- `tests/integration/data-detector.test.ts` — 13 cases through the real API and runner against
  seven new fixture routes: the known positive, the stock positive, the healthy negative, and
  one route per abstention, plus all three detectors on one scan and the handoff spelling
  being recorded as the engine one.

## Status

**Accepted.** Three of six detectors built. `CE-CONTENT-01`, `CE-VISUAL-01` and `CE-MOBILE-01`
remain specified and unrequestable; all three are rubric-and-judgement rules rather than
deterministic ones, and each needs a category rubric that does not exist yet.
