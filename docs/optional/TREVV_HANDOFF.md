# Optional · TREVV handoff

**Not implemented. Not in any current milestone.** The handoff had this inside
`M5_MONITORING_AND_TREVV`; M5 is [monitoring and operations](../roadmap/M5_MONITORING_AND_OPERATIONS.md)
now, and this is optional internal integration.

## What it would be

Pushing an approved opportunity or an accepted scope into TREVV as a task, so delivery work is
tracked where the rest of the work is tracked.

## Why it is optional

It is an internal convenience, not a product capability. No customer of the Brand Consistency
Scanner benefits from it, and nothing in the scan-to-report journey depends on it. Building it
into a milestone would put an internal tool on the critical path of a product.

There is also a boundary worth keeping: this system holds evidence about other people's
websites, contact addresses from public requests, and reviewed claims somebody's name is
attached to. Every one of those is a thing that should cross into another system
deliberately, with a decision about what goes and what does not, rather than because a task
sync existed.

## What would have to be true first

1. Delivery work is actually happening at a volume where tracking it by hand hurts.
2. A decided answer to what crosses the boundary. A task title and a link, almost certainly —
   not evidence, not contact details, not reviewer notes.
3. One direction only, at least at first. TREVV receiving approved work is a different risk
   from TREVV changing anything here.
