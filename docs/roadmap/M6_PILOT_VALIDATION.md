# M6 · Pilot validation

**Not started.** Supersedes `opportunity-engine-build-kit/tasks/M6_PILOT_AND_EXPANSION.md`.
The "expansion" half carried an agency-SaaS framing that is
[optional and deferred](../optional/AGENCY_SAAS_EXPANSION.md).

## What this milestone is for

Finding out whether the thing works on real sites for real customers who paid. Not a launch
plan — a validation one.

## The bar

- **Independent paid pilot engagements**, acquired without automated outreach. The handoff is
  explicit that demand is not validated until this exists, and it is right.
- **Live capture proven**, with the deny-private-network egress boundary demonstrated and
  recorded per [ADR-005], on redirects and subresources as well as initial URLs.
- **Detector precision measured on real pages**, with every false positive and every
  abstention recorded. A detector that has only ever run on fixtures has not been tested.
- **A delivered repair that passed its own acceptance tests**, so the effort band in the
  catalogue stops being an estimate.

## What would count as failing the pilot

Worth writing down in advance, while it is still cheap to say:

- Findings are true but nobody will pay to fix them.
- The reviewer bottleneck makes the unit economics impossible.
- Real pages produce abstentions so often that the output is not useful.
- Customers want the fix, not the diagnosis, and the diagnosis cannot be priced separately.

None of these is a reason to weaken a detector or a refusal to make the numbers work.
