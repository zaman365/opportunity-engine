import type { QueryExecutor } from './client.ts';
import { ledgerErrorCode } from './client.ts';

/**
 * Typed wrapper over the budget command functions in migration 0003.
 *
 * There is no fallback path: the runtime role has SELECT only on the budget tables, so if a
 * function call fails the reservation genuinely did not happen. Callers must run these
 * inside the same transaction as the business write they are admitting.
 */

export class LedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LedgerError';
  }
}

function rethrow(error: unknown): never {
  const code = ledgerErrorCode(error);
  if (code) throw new LedgerError(code, code, { cause: error });
  throw error;
}

export interface ReserveInput {
  scanId: string;
  operationKey: string;
  /** sha256 of the canonical request; binds a retry to identical input. */
  requestHash: string;
  currency: string;
  amountMicro: string;
  /** Every applicable scope, resolved server-side. A caller cannot omit a parent cap. */
  budgetIds: string[];
}

export interface Reservation {
  reservationId: string;
  state: string;
  replayed: boolean;
}

export async function reserveBudget(tx: QueryExecutor, input: ReserveInput): Promise<Reservation> {
  try {
    const result = await tx.query<{ reservation_id: string; state: string; replayed: boolean }>(
      'SELECT * FROM oe.reserve_budget($1, $2, $3, $4, $5::bigint, $6::uuid[])',
      [
        input.scanId,
        input.operationKey,
        input.requestHash,
        input.currency,
        input.amountMicro,
        input.budgetIds,
      ],
    );
    const row = result.rows[0]!;
    return { reservationId: row.reservation_id, state: row.state, replayed: row.replayed };
  } catch (error) {
    rethrow(error);
  }
}

export async function settleReservation(
  tx: QueryExecutor,
  input: { operationKey: string; actualMicro: string; providerRequestId: string | null },
): Promise<{ reservationId: string; overrun: boolean; replayed: boolean }> {
  try {
    const result = await tx.query<{ reservation_id: string; overrun: boolean; replayed: boolean }>(
      'SELECT * FROM oe.settle_reservation($1, $2::bigint, $3)',
      [input.operationKey, input.actualMicro, input.providerRequestId],
    );
    const row = result.rows[0]!;
    return { reservationId: row.reservation_id, overrun: row.overrun, replayed: row.replayed };
  } catch (error) {
    rethrow(error);
  }
}

/**
 * `confirmedNoCharge` must come from an actual reconciliation, not from the fact that a
 * request timed out. The function rejects anything else.
 */
export async function releaseReservation(
  tx: QueryExecutor,
  input: { operationKey: string; confirmedNoCharge: boolean },
): Promise<{ reservationId: string; replayed: boolean }> {
  try {
    const result = await tx.query<{ reservation_id: string; replayed: boolean }>(
      'SELECT * FROM oe.release_reservation($1, $2)',
      [input.operationKey, input.confirmedNoCharge],
    );
    const row = result.rows[0]!;
    return { reservationId: row.reservation_id, replayed: row.replayed };
  } catch (error) {
    rethrow(error);
  }
}

export async function markReservationUncertain(
  tx: QueryExecutor,
  operationKey: string,
): Promise<string> {
  try {
    const result = await tx.query<{ mark_reservation_uncertain: string }>(
      'SELECT oe.mark_reservation_uncertain($1)',
      [operationKey],
    );
    return result.rows[0]!.mark_reservation_uncertain;
  } catch (error) {
    rethrow(error);
  }
}

export async function createBudget(
  tx: QueryExecutor,
  input: {
    id: string;
    scopeKind: 'tenant' | 'venture' | 'scan';
    scopeId: string;
    currency: string;
    limitMicro: string;
    paused: boolean;
  },
): Promise<string> {
  try {
    const result = await tx.query<{ create_budget: string }>(
      'SELECT oe.create_budget($1, $2, $3, $4, $5::bigint, $6)',
      [input.id, input.scopeKind, input.scopeId, input.currency, input.limitMicro, input.paused],
    );
    return result.rows[0]!.create_budget;
  } catch (error) {
    rethrow(error);
  }
}

export async function configureBudget(
  tx: QueryExecutor,
  input: { budgetId: string; expectedVersion: number; limitMicro: string; currency: string },
): Promise<number> {
  try {
    const result = await tx.query<{ configure_budget: number }>(
      'SELECT oe.configure_budget($1, $2, $3::bigint, $4)',
      [input.budgetId, input.expectedVersion, input.limitMicro, input.currency],
    );
    return result.rows[0]!.configure_budget;
  } catch (error) {
    rethrow(error);
  }
}

export async function setBudgetPaused(
  tx: QueryExecutor,
  input: { budgetId: string; expectedVersion: number; paused: boolean },
): Promise<number> {
  try {
    const result = await tx.query<{ set_budget_paused: number }>(
      'SELECT oe.set_budget_paused($1, $2, $3)',
      [input.budgetId, input.expectedVersion, input.paused],
    );
    return result.rows[0]!.set_budget_paused;
  } catch (error) {
    rethrow(error);
  }
}

export interface BudgetRow {
  id: string;
  scope_kind: 'tenant' | 'venture' | 'scan';
  scope_id: string;
  currency: string;
  limit_micro: string;
  reserved_micro: string;
  settled_micro: string;
  paused: boolean;
  version: number;
}

export async function listBudgets(tx: QueryExecutor): Promise<BudgetRow[]> {
  const result = await tx.query<BudgetRow>(
    `SELECT id, scope_kind, scope_id, currency,
            limit_micro::text, reserved_micro::text, settled_micro::text, paused, version
       FROM oe.budgets
      ORDER BY scope_kind, id`,
  );
  return result.rows;
}

export async function getBudget(tx: QueryExecutor, id: string): Promise<BudgetRow | null> {
  const result = await tx.query<BudgetRow>(
    `SELECT id, scope_kind, scope_id, currency,
            limit_micro::text, reserved_micro::text, settled_micro::text, paused, version
       FROM oe.budgets WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Resolve the full cap hierarchy a scan operation must satisfy: tenant → venture → scan.
 *
 * The caller never supplies this list. BUDGET_LEDGER.md: "Clients never choose which parent
 * caps to omit."
 */
export async function resolveScanBudgetIds(
  tx: QueryExecutor,
  input: { tenantId: string; ventureId: string; scanId: string },
): Promise<{ ids: string[]; missing: ('tenant' | 'venture' | 'scan')[] }> {
  const result = await tx.query<{ id: string; scope_kind: string; scope_id: string }>(
    `SELECT id, scope_kind, scope_id FROM oe.budgets
      WHERE (scope_kind = 'tenant'  AND scope_id = $1)
         OR (scope_kind = 'venture' AND scope_id = $2)
         OR (scope_kind = 'scan'    AND scope_id = $3)`,
    [input.tenantId, input.ventureId, input.scanId],
  );
  const byKind = new Map(result.rows.map((row) => [row.scope_kind, row.id]));
  const missing: ('tenant' | 'venture' | 'scan')[] = [];
  for (const kind of ['tenant', 'venture', 'scan'] as const) {
    if (!byKind.has(kind)) missing.push(kind);
  }
  return { ids: [...byKind.values()].sort(), missing };
}
