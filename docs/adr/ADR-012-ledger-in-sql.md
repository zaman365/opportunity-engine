# ADR-012 · budget writes only through SQL command functions

**2026-09-21 · accepted**

## Problem

BUDGET_LEDGER.md: "Production must implement this as an authoritative database operation with
restricted execute permissions; an in-memory copy of the reference ledger is not acceptable.
Runtime CRUD permissions must not permit manually bypassing the ledger." The kit's
`db/001_core.sql` deliberately grants nothing.

## Decision

Migration `0003_budget_commands.sql` defines `reserve_budget`, `settle_reservation`,
`release_reservation`, `mark_reservation_uncertain`, `configure_budget`, `set_budget_paused` and
`create_budget` as `SECURITY DEFINER` functions. Migration `0002_runtime_privileges.sql` gives
the runtime role `SELECT` only on `oe.budgets`, `oe.reservations` and
`oe.reservation_allocations`, plus `EXECUTE` on those functions. There is no other write path.

`FORCE ROW LEVEL SECURITY` applies to the definer as well, so a function still cannot touch
another tenant's rows: the transaction-local `oe.tenant_id` setting decides visibility exactly
as it does for a direct query.

Migration `0007_reserve_required_scopes.sql` then removed the last soft spot: `reserve_budget`
resolves the required tenant → venture → scan scope set from the scan row itself and rejects
any supplied set that does not match. Omitting a parent cap is a database error, not a
convention a caller is trusted to follow.

## Alternatives rejected

- **Repository-level discipline in TypeScript.** Correct only while every caller is correct,
  and invisible to anything auditing the grants.
- **Trusting the caller's scope list** (the shape 0003 shipped with). One forgotten parent cap
  silently narrows the ceiling.

## Security and cost

An overrun is recorded as real spend and pauses every covering scope rather than being
discarded to keep the invariant looking clean. Resuming a scope whose committed spend still
exceeds its limit is refused (`OVERRUN_NOT_RECONCILED`).

## Rollback

Drop the functions and re-grant table writes. That re-opens the bypass, so it is a decision, not
a cleanup.

## Verification

`tests/db/budget-ledger.test.ts`, 20 tests: concurrent admission at the cap across real
connections, a 12-way burst holding the invariant, reversed scope order, duplicate and altered
operation keys, rollback after reserving, duplicate settlement, ambiguous provider result,
overrun, currency mismatch and the two refusals above. Assertions read final database totals,
not API status codes.
