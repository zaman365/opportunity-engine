# Data model, transactions and migration plan

## Scope

`db/001_core.sql` is a concrete initial PostgreSQL schema candidate for M1. It includes tenant-scoped IDs, composite foreign keys, indexes, checks and forced RLS. It does **not** contain a deployed role configuration, authentication service, action-level policy enforcement, complete budget command functions or application transaction adapter. Those are explicit M1 implementation tasks. See VERIFICATION.md for exactly how this candidate was checked.

The starting schema deliberately excludes OAuth tokens, customer payment details, monitoring, generalized CRM and all future venture-specific models. Add them in their milestone with migration and access tests rather than creating a speculative universal graph.

## Identity and membership

Tenants represent isolated data/controller boundaries; ventures represent approved brands within a tenant. Membership maps trusted issuer+subject to role; member_ventures limits brand access. Bootstrap/resolve membership through a separately permissioned identity repository that only queries the cryptographically verified issuer/subject. Do not grant the general runtime unrestricted membership reads. Never use an unverified header to set tenant context.

After resolution, begin a transaction and use `SELECT set_config('oe.tenant_id', $1, true)`. The final `true` makes context transaction-local. Perform scoped statements in that transaction with a non-owner, non-superuser, non-BYPASSRLS role. No context means no row visibility. Test pooled connection reuse; disable tenant-sensitive query caching. RLS is defense in depth, not the entire permission model [S12].

## Relationships

Account belongs to one initial primary venture within a tenant; opportunities may route to other approved venture scopes with explicit permission and one owner. Canonical domain is unique only **within** a tenant. Assets → account. Scan → account/venture/authorization/requester. Evidence → scan/asset. Finding → scan/asset and supporting/contrary evidence through a relation table. Opportunity → findings through a relation table. Report → immutable snapshot plus exact finding-version bindings. Review → finding/version/reviewer.

Composite foreign keys prevent linking another tenant's objects even when its UUID is known. They do not prove same-account consistency inside a tenant: the admission/review transaction must verify that authorization/account, scan/asset, finding/evidence and report/finding all match intended accounts and scope. Add composite account constraints where they reduce ambiguity; test mismatches explicitly. Do not read raw constraint messages to a customer.

## Immutability and versions

Evidence capture records are append-only except retention/redaction metadata; corrected evidence is a new record. Review events and report snapshots are immutable. Findings/reports carry positive version counters and optimistic compare-and-swap updates. Published report body's hash binds the rendered snapshot. New evidence invalidates draft publication eligibility, not previously recorded history. Deletion policy may remove bytes while a minimized tombstone preserves audit provenance when permitted.

## Budget writes

Budgets, reservations and allocation tables need command-only transactional writes—not broad runtime UPDATE grants. Implement reserve/settle/release/configure functions or a tightly scoped repository boundary with restricted service roles. Resolve required tenant/venture/scan budget rows server-side, validate polymorphic scope IDs, lock in stable order, verify currencies and use operation-key idempotency. SQL cannot accept client-chosen missing parent caps. Spec and reference math are in BUDGET_LEDGER.md.

Stored values are bigint; initial API cost strings allow 15 digits. Owner caps and operation bounds must keep ordinary arithmetic safely representable. Exceptional provider overruns are reconciled with an incident representation and pause; never fail to record real incurred cost just to keep a constraint green. M1 operates in one owner-approved currency; no implicit FX.

## Outbox and retries

Scan admission and outbox insert share one transaction. Dispatcher uses leased rows and deterministic provider instance IDs. Leases expire after crash; duplicates reconcile by event/step/operation ID. Unique keys enforce identity, not exactly-once effects by themselves. Implement deliberate retries around serialization/deadlock errors and ambiguous provider responses [S13].

## Applying migrations

Local/disposable DB first; migrate as a dedicated role, create restricted runtime/identity/budget roles separately, apply reviewed grants, then run tests. Do not use `GRANT ALL ON ALL TABLES` or runtime owner credentials. A schema parse check does not prove RLS, triggers, privileges or concurrency. Add application migration history/version tracking in M0 rather than rerunning CREATE statements against existing production.

## Database acceptance

Empty-schema install; from-prior-version upgrade; non-owner deny without context; correct tenant allowed; tenant B read/write/link denied; active membership/venture role guards; transaction context resets; same-tenant cross-account relationship rejected by command; duplicate review/report versions; immutable snapshot update denied; parallel budget cases; outbox lease recovery; stale-state CAS; deletion and backup/restore. Record exact server version and commands. A local fixture in memory is not a database test.
