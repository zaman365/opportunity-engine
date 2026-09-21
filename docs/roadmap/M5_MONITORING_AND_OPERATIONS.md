# M5 · Monitoring and operations

**Not started.** Supersedes `opportunity-engine-build-kit/tasks/M5_MONITORING_AND_TREVV.md`.
The TREVV half is [optional](../optional/TREVV_HANDOFF.md) and not part of this milestone.

## Scope

- **Separately authorized monitoring.** Re-running a check on a schedule is a new, ongoing
  permission, not an extension of the one that allowed a single scan. It gets its own
  authorization, its own budget ceiling and its own revocation.
- **Change detection that distinguishes a fix from a regression from a redesign**, and says
  which it saw rather than asserting a trend.
- **Operations**: the rate-limit sweep, evidence retention and deletion, reconciliation of
  uncertain ledger reservations, and a runbook for each.
- **Per-detector kill switches**, so one bad rule is disabled without a deployment.

## What monitoring must not become

Continuous unauthorized crawling. A monitored account is one that asked to be monitored, on
the hosts it approved, at a cadence it agreed to, with a way to stop that works immediately.
