# Optional · Agency SaaS and expansion

**Not implemented. Not in any current milestone.** Deferred indefinitely, and some of it is
excluded outright.

## What it would be

Selling the engine to agencies as SaaS; a marketplace; licensing the accumulated scan data;
mass crawling to build a database of sites with problems; automatic website changes.

## Why not

**Mass crawling is the one to refuse first.** The entire evidentiary standing of this product
rests on scanning only what an owner approved, with a recorded authorization, for a stated
purpose. A crawler that inspects sites nobody asked about does not weaken that principle — it
abandons it, and it cannot be re-adopted afterwards for the pages already crawled. Every
address rule in the system exists to make this impossible by construction, and the
architecture should keep it impossible.

**Data licensing** has the same shape one step further out. The scan records are observations
about other people's businesses, gathered under a purpose permission that said what they were
for. Selling them is not a new revenue line; it is a use nobody consented to.

**Automatic website changes** is a different liability entirely.
`AUTOMATIC_PRODUCTION_WRITES_ENABLED` is refused at startup and should stay refused.

**Agency SaaS** is merely premature rather than wrong. It means supporting other people's
workflows before this one has been shown to work, and it multiplies the cost of every change
to a detector by the number of agencies relying on the old behaviour.

## What would have to be true first

For agency SaaS: a proven pilot, a stable detector set, and agencies asking. For the rest:
nothing. Mass crawling and data licensing are not "later" — they are contrary to what the
product is, and if they become the plan it should be a deliberate decision to build a
different product, taken with that stated plainly.
