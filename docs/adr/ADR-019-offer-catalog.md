# ADR-019 · Scope from a catalogue, price from an owner, and neither from this code

**2026-09-21 · accepted**

## Problem

BUILD_SPEC.md §9 specifies the offer matcher as "Rule-based catalog plus LLM explanation ·
Verified need + prerequisites → eligible offer draft · **Price/scope from catalog, not free
generation.**" M2's acceptance adds: "Catalog change requires owner and new version; existing
quotes remain immutable", and §18: "Offers consume a delivery capacity budget as well as an
API budget."

The kit ships `config/offer-catalog.json` with two SKUs, both `"enabled": false` and both
`"price_minor": null`, under the note "Draft scopes only. Prices/terms/capacity must be
approved before quotation. No live commercial offer enabled."

So there was a confirmed finding at one end and nothing at the other. This is the step that
first makes the system say a number out loud, and it is the step where a plausible-sounding
number would do the most damage: a price nobody approved, attached to a scope nobody agreed,
handed to a customer.

## Decision

**Scope and price are separate files, because they are separate authorities.** The kit's
`config/offer-catalog.json` stays byte-identical and defines what a SKU promises. A new
`config/offer-approvals.json` records what the owner approved on top of it — price, currency,
tax treatment, effort band, approver and time. `mergeOfferCatalog` joins them on `sku@version`,
so an approval does not follow a scope to a new version: if the scope changes, somebody has to
look again.

**"Enabled requires an approved price" is a database constraint, not a convention.**

```sql
CONSTRAINT offers_enabled_requires_approval CHECK (
  NOT enabled
  OR (price_minor IS NOT NULL AND currency IS NOT NULL
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
)
```

The rule is stated three times on purpose: in the merge, where it produces a readable refusal
naming the SKU; in the matcher, which will not return an unpriced entry as eligible; and here,
where it holds even against a caller that skipped both.

**Matching is deterministic.** `matchOffers` is a pure function over confirmed findings and
catalogue rows. It cannot generate a price, widen a scope, or decide that unsupported work is
supportable. When nothing matches it sets `route_to_manual_quotation`, which is an answer —
"this is a conversation, not a SKU" — rather than a failure or a reason to stretch an existing
scope.

**A draft snapshots what it quoted.** `oe.offer_drafts` copies price, currency and the whole
scope rather than referencing the catalogue row. "Existing quotes remain immutable" means a
catalogue change must not silently reprice something already put in front of somebody. A
partial unique index allows one open draft per case and SKU: two would be two prices for one
job.

**Prerequisites are recorded claims, not observations.** "Authorized code/platform access",
"agreed destination", "scope approval" — nothing the engine captures can establish any of
them. `oe.offer_prerequisites` gives them the same shape as a review: an owner records one
with a note explaining how they know, stays named for it, and can revoke it with a reason.
Until they are recorded an eligible scope is visible but not draftable, which is the honest
state. The note stays in the audit record and out of the projection: a viewer sees that a
prerequisite is met, not the customer's details.

**Delivery capacity defaults to zero, not to unlimited.** A workspace that has never said how
much delivery it can absorb has not said "as much as you like" — the same rule BUDGET_LEDGER.md
applies to cost ceilings.

**The catalogue is scoped to a venture.** Membership is per venture (ACCESS_MODEL.md), so a
price list is too. A contractor working on one brand has no business reading another brand's
prices.

## What the owner approved

| SKU                  | Price       | Effort    | State   |
| -------------------- | ----------- | --------- | ------- |
| `MF-LINK-REPAIR`     | EUR 290 net | 1–3 h     | enabled |
| `PDP-REVIEWED-AUDIT` | EUR 190 net | 0.8–1.3 h | enabled |

Reasoning is in `docs/commercial/OFFER_PRICING.md`. Both approval notes record the same open
question: **VAT treatment is unconfirmed.** The price is net, and whether VAT is added depends
on a registration status nobody has verified. That has to be settled before a quote reaches a
customer, and it is recorded in the data rather than in somebody's memory.

## Alternatives rejected

- **A price field in the drafting UI.** One typo becomes a commitment. There is no price input
  anywhere in the operator application, and the e2e test asserts its absence rather than
  trusting that nobody added one.
- **Editing a SKU in place when a price changes.** Would reprice quotes already given. The
  runtime role has `INSERT` but never `UPDATE` on `oe.offers`; a change is a new version.
- **Inferring prerequisites from existing records.** An `oe.authorizations` row permits a scan;
  it does not mean anyone agreed a destination. Treating one as the other would manufacture
  consent from an unrelated permission.
- **Treating "no capacity set" as unlimited.** The failure mode is committing to delivery
  nobody can staff, which is worse than a refusal that names the missing number.
- **Putting the offer price in `Money`.** `Money` is provider cost in micro-units of the ledger
  currency; this is what a customer pays, in minor units of a sale currency. Different names
  (`amount_minor` vs `amount_micro`) make mixing them a schema error rather than an arithmetic
  one off by four orders of magnitude.

## Affected contracts

Ten schemas and four operations, added through `contracts/overlay.json` (ADR-018) so the kit's
document stays byte-identical: `Offer`, `OfferPrice`, `EligibleOffer`, `OfferMatch`,
`OfferDraft`, `OfferDrafts`, `CreateOfferDraft`, `WithdrawOfferDraft`, `OfferPrerequisite`,
`OfferPrerequisites`, `RecordOfferPrerequisite`, `RevokeOfferPrerequisite`; `GET
/v1/opportunities/{id}/offers`, `GET`/`POST /v1/opportunities/{id}/offer-drafts`, `POST
/v1/offer-drafts/{id}/withdraw`, `GET`/`POST /v1/accounts/{id}/offer-prerequisites` and its
`/revoke`.

All additive. `CreateOfferDraft` carries only `offer_id` — there is no field through which a
caller could supply a price.

Writing `tests/contract/openapi-routes.test.ts`, which `apps/api/src/app.ts` had claimed
existed, found three read operations that were implemented and served but never declared:
`GET /v1/scans/{id}/timeline`, `GET /v1/accounts/{id}/authorizations` and `GET
/v1/findings/{id}/reviews`. The overlay now declares them, so the served contract describes
every route the application mounts.

## Security and cost

No new egress and no new provider calls: matching is arithmetic over rows already held. Four
new error codes (`OFFER_NOT_ELIGIBLE`, `OFFER_PREREQUISITES_UNMET`, `OFFER_DRAFT_EXISTS`,
`DELIVERY_CAPACITY_REACHED`) state a refusal without leaking whether a SKU exists in another
venture.

Drafting is a reviewer act — the same rank as publishing a report, because it is the same kind
of act: standing behind something a customer will read. Recording a prerequisite is an owner
act, because it is a claim about a customer relationship rather than about evidence.

Nothing here sends anything. A draft is an internal record; external delivery remains a
separate, later permission, and `AUTOMATIC_OUTREACH_ENABLED` is still refused at startup — now
for a legal reason as well as a design one (`docs/legal/DACH_OUTREACH_STUDY.md`).

## Migration and rollback

`packages/db/migrations/0009_offer_catalog.sql` is additive: four new tables, no change to any
existing one. Rolling back means dropping them; nothing else reads them. The seeder writes
catalogue rows with `ON CONFLICT DO NOTHING`, so re-seeding after an approval changes nothing
until the version moves — which is the immutability rule, not an oversight.

One behaviour outside the new tables did change. `oe.opportunities.next_action` now moves: a
case whose findings are all decided and at least one confirmed becomes `draft_offer`. The rule
lives in one place (`nextActionForCase`) because two writers need it — the review service when
a decision is made, and the scan runner when a new finding lands on an existing case. The
runner previously left `next_action` alone for an existing case, which was invisible while
every case sat at `review_evidence` forever and would have hidden a fresh candidate behind a
next step nobody could take.

## Verification

- `tests/unit/offer-matcher.test.ts` — 26 cases, mostly refusals: unpriced, not enabled,
  unconfirmed, unsupported detector, unmet prerequisites, capacity reached, zero capacity,
  approval/catalogue currency conflict, an approval that does not follow a version bump, a
  price that is not integer minor units, and BigInt formatting past the float-safe range.
- `tests/db/offer-catalog.test.ts` — the constraint refuses an enabled row with no price and
  one priced by nobody, straight from SQL; one open draft per case and SKU; withdrawal frees
  the slot; a revoked prerequisite is kept and can be claimed again; tenant B's catalogue is
  empty.
- `tests/integration/offer-catalog.test.ts` — the full path through the real API: nothing
  offered before confirmation, `next_action` moving to `draft_offer`, the refusal at 422 with
  the prerequisites named, a reviewer refused when recording one, the draft carrying its
  snapshot, a second draft refused at 409, withdrawal, and revocation making it undraftable
  again.
- `tests/e2e/operator.spec.ts` — in the browser: the price on screen with its exclusions, no
  price input anywhere in the panel, the draft button disabled until an owner records the
  prerequisites, and withdrawal refusing an empty reason.

## Status

**Accepted.** The prices are provisional and the VAT treatment is unresolved; both are recorded
as such in `config/offer-approvals.json` and surfaced in the approval note rather than being
tidied away.
