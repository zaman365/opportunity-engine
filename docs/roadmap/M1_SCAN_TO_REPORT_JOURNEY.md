# M1 · Scan to protected report

**Complete against local fixtures.** Supersedes
`opportunity-engine-build-kit/tasks/M1_ONE_REAL_JOURNEY.md`; scope unchanged, renamed for what
it produces.

One journey, end to end and real: admit a scan against an approved host with a recorded
authorization, capture two independent comparable sessions, store evidence in a private
object store, produce a candidate finding, have a person review it against that evidence, and
compose a protected report bound to the exact finding version they confirmed.

**Still blocked:** live capture. `BrowserRunCaptureProvider` reports itself unconfigured and
never falls back to fixture data. [ADR-005] keeps it that way until a deny-private-network
egress boundary is demonstrated and recorded — not asserted. Everything else in M1 runs.
