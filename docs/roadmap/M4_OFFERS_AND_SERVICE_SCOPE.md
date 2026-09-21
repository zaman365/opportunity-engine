# M4 · Offers and accepted service scope

**Slice 1 complete.** Gathers the commercial half of the handoff's `M2_DETECTORS_AND_OFFERS`
and `M3_CUSTOMER_AND_ENGAGEMENTS` into one milestone, because they are one subject: turning a
confirmed finding into work somebody agreed to buy.

## Slice 1 · the offer catalogue — **done**

Deterministic matching from an owner-approved catalogue; scope from the kit's definition and
price from a separate owner approval; "enabled requires an approved price" as a database
constraint; prerequisites recorded by a named owner with a note; a draft that snapshots what
it quoted. [ADR-019](../adr/ADR-019-offer-catalog.md).

There is no price input anywhere in the application, and no field in the API through which a
caller could supply one.

## Slice 2 · accepted scope and engagements — next

- A customer accepts a specific offer draft version, at a recorded time.
- The engagement state machine WORKFLOWS.md specifies:
  `draft → awaiting_acceptance → awaiting_prerequisites → ready → in_progress →
awaiting_verification → accepted → closed`, with `change_requested`, `cancelled` and
  `disputed` as side states carrying an explicit reason and owner.
- No work starts before an accepted offer version, the required permissions and the
  contract/payment prerequisites.
- Acceptance follows verified work plus the customer's own acceptance — **not** a
  "payment succeeded" webhook.
- A scope change creates a new approved version rather than editing one somebody accepted.
- Manual invoice and payment-status records, audited. No card data, ever. A hosted checkout,
  if it ever exists, is a separate authorization and its own integration tests.

## Open commercial questions

- **VAT treatment is unconfirmed.** Both approved prices are net. Whether VAT is added depends
  on a registration status nobody has verified, and it has to be settled before a quote
  reaches a customer. Recorded in `config/offer-approvals.json` rather than in someone's
  memory.
- **Neither price has survived a delivery.** The effort bands are estimates.
