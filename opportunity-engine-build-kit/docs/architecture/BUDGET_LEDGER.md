# Budget ledger and idempotency

## Invariant and units

All internal costs use a three-letter currency plus integer micro-units (1 unit = 0.000001 currency unit). JSON transports micro-unit amounts as decimal strings, avoiding JavaScript precision loss. SQL uses bigint. No arithmetic on floating point `0.03`. Commercial EUR minor-unit prices are separate from provider USD micro-unit usage. Never add EUR to USD without a recorded FX conversion.

For each applicable budget: `settled_micro + reserved_micro + proposed_micro <= limit_micro`.

M1 has one accounting currency per tenant, configured by the owner, and all provider steps require an approved price snapshot in that currency. Unknown price blocks the step. Later multi-currency accounting records provider-original and ledger-converted amounts plus FX time, rate source, buffer and reconciliation.

## Hierarchy

Tenant lifetime budget → venture budget → scan budget; optional account and daily-period budgets are additional constraints. Owner configures limits; API resolves required budget IDs server-side. Clients never choose which parent caps to omit. Daily buckets have explicit IANA timezone/reset rules and immutable period start/end; lifetime caps do not reset each day.

## Admission transaction

1. Authenticate and authorize; resolve required budget rows.
2. Lock all rows in sorted stable order; verify same currency, correct hierarchy, active period, tenant and not paused.
3. Find existing reservation by `(tenant_id, operation_key)`. Return it only if canonical request hash and scope/cost match; otherwise 409.
4. Test every applicable cap; create one reservation with budget allocation rows and increment reserved totals in the same transaction.
5. Commit. Only now can the external operation start.

Production must implement this as an authoritative database operation with restricted execute permissions; an in-memory copy of the reference ledger is not acceptable. Use row locks/serializable retry as specified in the schema notes. Runtime CRUD permissions must not permit manually bypassing the ledger.

## Settlement and ambiguity

Use provider request ID and event/operation key. Settle once with exact recorded cost; reconcile after ambiguous timeouts instead of blindly repeating chargeable requests. If actual <= reserve, reduce reserved by the whole reservation and increment settled by actual. If actual > reserve, record actual spend, mark budget paused/overrun, emit an incident, and block new operations. Do not pretend an unexpected provider charge did not happen merely to preserve the cap invariant.

A cancellation after a paid call starts may not refund incurred cost. Reserved-but-never-started work can be released. Unknown provider status remains uncertain and continues consuming reserved allowance until reconciled. Release requires evidence no spend was incurred or the provider cost has been settled elsewhere with a traceable link.

## Payment distinction

This ledger is **internal cost control**, not a customer wallet or charge permission. M1/M2 have no payment-card collection or automatic customer billing. M3 can record manual/invoice acceptance; Stripe is a separate later adapter with hosted checkout, verified idempotent webhooks and explicit scope. Do not bill provider usage from scan admission alone.

## Required database tests

Simultaneous reservations across two connections near cap; reversed parent ordering; duplicate operation key identical/changed; rollback after child update; cancellation in-flight; duplicate settlement; unknown provider result; overrun; revoked tenant access; currency mismatch; stale daily period. Assert final database totals and side-effect counts, not only API status.

`reference/budget-ledger.mjs` demonstrates deterministic math and idempotency in memory. Its tests cannot establish atomicity, database locking or provider billing correctness.
