# ADR-023 · Acceptance is a recorded act, not a payment event

**2026-09-22 · accepted**

## Problem

M4's second slice turns a drafted scope into work somebody agreed to buy. WORKFLOWS.md sets
the lifecycle and three rules with it:

> `draft → awaiting_acceptance → awaiting_prerequisites → ready → in_progress →
awaiting_verification → accepted → closed`. Side states `change_requested`, `cancelled` and
> `disputed` have explicit reason/owner. No start before accepted offer version, required
> permissions and payment/contract prerequisites. **Acceptance follows verified work plus
> customer/authorized owner acceptance, not a "payment succeeded" webhook.** Scope change
> creates a new approved version.

The temptations are specific and each one is a real system somewhere: let a payment webhook
mark work accepted, let a scope be edited in place because the customer asked for one change,
and let an engagement carry its own copy of the price so a screen can render without a join.

## Decision

**An engagement is bound to one offer draft, and there is no scope on it.** No price column,
no inclusions, no snapshot. The draft already holds an immutable copy of what was quoted, and
a second copy is a second chance for the two to disagree. `offer_draft_id` is not in the
runtime role's `UPDATE` grant, so "scope change creates a new approved version" holds against
a caller that skipped the service layer.

**`change_requested` leads back to `draft`, not onward.** A changed scope is a new quote to
accept, not an amendment to one already accepted — so the path out of a change request goes
through drafting again, and the acceptance that was recorded against the old scope does not
carry over to the new one.

**Acceptance is a time, a note and a named member.** Not a boolean. The note says how it was
obtained — "accepted by email on 22 September, quoting the scope" — because "they accepted"
with nothing behind it is precisely the assertion a dispute turns on. The member recording it
is attesting to it, the same shape as a reviewer confirming a finding, and for the same reason.

**A payment moves nothing.** `POST /v1/engagements/{id}/payments` writes a record and returns;
it cannot change a state. An integration test asserts the engagement's state and version are
identical across an invoice and a payment, and the audit detail says `moved_engagement_state:
false` in as many words, because that is the thing somebody will later assume happened.

**No card data, anywhere.** No column, no field in any request schema, no processor token, no
webhook. Somebody types what happened — an invoice number, a bank reference, an amount in
minor units — and is named for typing it. That is worth more than an integration nobody
authorised, and it cannot leak what it never held.

**Three rules are enforced twice.** Each is a readable refusal in the service and a CHECK
constraint in migration 0013:

| Rule                                                          | Constraint                               |
| ------------------------------------------------------------- | ---------------------------------------- |
| Nothing past acceptance without an acceptance                 | `engagements_no_start_before_acceptance` |
| An acceptance is a time, a note and a person, or none of them | `engagements_acceptance_complete`        |
| A side state names its reason and its owner                   | `engagements_side_state_explained`       |

**An acceptance note is refused where it does not belong.** Sent on a transition that records
no acceptance, it is a 422 rather than a silently ignored field — otherwise somebody could
believe they had recorded an acceptance that is not there.

**One live engagement per scope**, where live means not cancelled and not closed. An
_accepted_ engagement is still live: the scope stays occupied until the work is closed out,
which is what stops two commitments to do one job existing side by side.

## The state machine lives here, not in the handoff

`MACHINES` is asserted edge-for-edge against the kit's `contracts/state-machines.json`, which
declares three machines. Adding a fourth there would either break that parity or require
editing the handoff. Same trade-off as ADR-018 and ADR-021, same resolution: the handoff stays
byte-identical, `ENGAGEMENT_MACHINE` is declared as this repository's own, and `ALL_MACHINES`
merges them for `transition` to judge.

The parity test now asserts both halves — the kit's three unchanged, and exactly one machine
added and named. It also asserts something worth pinning: **the only state that leads to
`accepted` is `awaiting_verification`.** Nothing else can reach it, by construction, which is
the machine-level form of "acceptance follows verified work".

## Alternatives rejected

- **A payment webhook that marks work accepted.** The thing WORKFLOWS.md rules out by name.
  Money arriving is evidence money arrived.
- **An editable scope on the engagement.** Convenient, and it makes "what did they agree to"
  unanswerable three months later.
- **Copying the price onto the engagement.** One join saved, one invariant lost.
- **A boolean `accepted` column.** It would pass every test and answer no question that
  matters.
- **Hosted checkout now.** It needs its own authorization and its own integration tests, and
  there is nothing to check out yet. Deferred honestly rather than half-built.
- **Letting an accepted engagement free its scope.** Accepted work is still work in hand.

## Affected contracts

Nine schemas and five operations via `contracts/overlay.json` (2.8.0): `EngagementState`,
`Engagement`, `Engagements`, `CreateEngagement`, `AdvanceEngagement`, `EngagementEvent`,
`EngagementDetail`, `PaymentRecord`, `RecordPayment`; `GET`/`POST /v1/engagements`,
`GET /v1/engagements/{id}`, `POST /v1/engagements/{id}/advance` and `.../payments`.

The payment operation is owner-only: money is an owner's record. Everything else in the
lifecycle is reviewer, because standing behind delivered work is the same rank of act as
standing behind a claim.

## Security and cost

No egress, no provider spend, no new public surface. The one thing worth naming: the
acceptance note and the engagement history are readable by a viewer. That is deliberate —
they are the record of what was agreed, and the people who have to answer a dispute are
exactly the people who need to read it. Nothing in these tables holds a contact address or a
payment instrument.

## Migration and rollback

`packages/db/migrations/0013_engagements.sql` adds three tables and touches nothing existing.
Rolling back means dropping them; the offer catalogue and everything before it are unaffected.

## Verification

- `tests/unit/reference-parity.test.ts` — the kit's three machines unchanged; exactly one
  added and named; every edge landing on a declared state; both terminals terminal; and
  `awaiting_verification` the only way into `accepted`.
- `tests/integration/engagement.test.ts` — 15 cases: an operator refused, a second live
  engagement refused, a jump to work refused as an illegal edge, a move past acceptance
  refused without a note, a note too short refused, a note where it does not belong refused,
  acceptance recorded with time and member, the full path to `accepted` with every transition
  and version in its history, a stale version refused, a reviewer refused a payment record, an
  invoice and a payment moving neither state nor version, no card-shaped field anywhere in the
  payment response, and `change_requested → draft` leaving the acceptance behind.

## Status

**Accepted.** Verification itself is still a human act recorded as a transition; the automated
acceptance-test run that `POST /v1/engagements/{id}/verify` implies in BUILD_SPEC.md §14 needs
live capture, which remains blocked by ADR-005. Recorded here rather than stubbed.
