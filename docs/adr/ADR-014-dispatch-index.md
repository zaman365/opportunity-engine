# ADR-014 · cross-tenant dispatch through a routing index

**2026-09-21 · accepted**

## Problem

The outbox is tenant-scoped with forced RLS, so a dispatcher holding no tenant context sees
nothing — correct for business data, but it still has to learn which tenants have pending work.

## Decision

Migration `0005_dispatch_index.sql` creates `oe_dispatch.outbox_index`, maintained by a trigger
on `oe.outbox`, holding only routing keys: tenant id, outbox id, event type, availability,
status and attempt count. No payload, no claim text, no account or URL. The dispatcher claims
due rows from the index with `FOR UPDATE SKIP LOCKED`, then opens a normal tenant-scoped
transaction to read and process the actual outbox row under RLS.

## Alternatives rejected

- **`BYPASSRLS` for the runner.** Grants access to everything to solve a scheduling problem.
- **Polling every tenant in turn.** Requires reading `oe.tenants`, which is itself RLS-scoped,
  and does not scale past a handful of workspaces.

## Security

Business data never leaves its tenant transaction. The index exposes which workspace has work
pending and when — the minimum a cross-tenant scheduler needs, and no more.

## Rollback

Drop the schema and the trigger; the dispatcher stops finding work.

## Verification

`tests/integration/edge-cases.test.ts` replays a delivered outbox row as if after a crash and
asserts the scan produces no second set of evidence and no second finding. A fresh `ScanRunner`
object standing in for a restarted process resumes an admitted scan and is a no-op on a second
call.
