import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configureBudget,
  createBudget,
  getBudget,
  listBudgets,
  markReservationUncertain,
  releaseReservation,
  reserveBudget,
  resolveScanBudgetIds,
  setBudgetPaused,
  settleReservation,
  type Database,
  type QueryExecutor,
} from '@oe/db';
import { freshHarness, LOCAL_FIXTURE, uuid, type Harness } from '../support/harness.ts';

/**
 * BUDGET_LEDGER.md, "Required database tests": simultaneous reservations across two
 * connections near cap; reversed parent ordering; duplicate operation key identical/changed;
 * rollback after child update; cancellation in-flight; duplicate settlement; unknown provider
 * result; overrun; currency mismatch.
 *
 * "Assert final database totals and side-effect counts, not only API status."
 */

let harness: Harness;
let db: Database;

const TENANT = LOCAL_FIXTURE.tenantA;
const HASH = 'a'.repeat(64);

beforeAll(async () => {
  harness = await freshHarness();
  db = harness.db;
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/** A scan row is required because reservations reference one. */
async function makeScan(tx: QueryExecutor): Promise<string> {
  const id = uuid();
  await tx.query(
    `INSERT INTO oe.scans (tenant_id, id, account_id, venture_id, authorization_id, target_url,
       state, version, expected_unique_pages, requested_by)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, 'https://atelier-nord.test/product',
       'queued', 1, 2, $5)`,
    [
      id,
      LOCAL_FIXTURE.accountA,
      LOCAL_FIXTURE.ventureA,
      LOCAL_FIXTURE.authorizationA,
      LOCAL_FIXTURE.operatorA,
    ],
  );
  return id;
}

async function scanWithCap(cap: string): Promise<{ scanId: string; budgetIds: string[] }> {
  return db.withTenant(TENANT, async (tx) => {
    const scanId = await makeScan(tx);
    await createBudget(tx, {
      id: uuid(),
      scopeKind: 'scan',
      scopeId: scanId,
      currency: 'USD',
      limitMicro: cap,
      paused: false,
    });
    const scopes = await resolveScanBudgetIds(tx, {
      tenantId: TENANT,
      ventureId: LOCAL_FIXTURE.ventureA,
      scanId,
    });
    expect(scopes.missing).toEqual([]);
    return { scanId, budgetIds: scopes.ids };
  });
}

/** Reset the seeded tenant/venture caps between tests. */
beforeEach(async () => {
  await db.withTenant(TENANT, async (tx) => {
    const budgets = await listBudgets(tx);
    for (const budget of budgets.filter((b) => b.scope_kind !== 'scan')) {
      if (budget.paused)
        await setBudgetPaused(tx, {
          budgetId: budget.id,
          expectedVersion: budget.version,
          paused: false,
        });
    }
  });
});

describe('hierarchical reservation', () => {
  it('resolves tenant, venture and scan scopes server-side', async () => {
    const { budgetIds } = await scanWithCap('1000000');
    expect(budgetIds).toHaveLength(3);
    const kinds = await db.withTenant(TENANT, async (tx) => {
      const budgets = await listBudgets(tx);
      return budgetIds.map((id) => budgets.find((b) => b.id === id)!.scope_kind).sort();
    });
    expect(kinds).toEqual(['scan', 'tenant', 'venture']);
  });

  it('rejects a caller that omits a parent cap', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    const onlyScan = await db.withTenant(TENANT, async (tx) => {
      const budgets = await listBudgets(tx);
      return budgetIds.filter((id) => budgets.find((b) => b.id === id)!.scope_kind === 'scan');
    });
    // The function re-derives the authoritative scope set from the scan row, so a partial
    // list is a database error rather than a quietly narrower cap check.
    await expect(
      db.withTenant(TENANT, (tx) =>
        reserveBudget(tx, {
          scanId,
          operationKey: `op:${scanId}`,
          requestHash: HASH,
          currency: 'USD',
          amountMicro: '100',
          budgetIds: onlyScan,
        }),
      ),
    ).rejects.toMatchObject({ code: 'MISSING_BUDGET' });

    const totals = await db.withTenant(TENANT, (tx) => listBudgets(tx));
    expect(
      totals.find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!.reserved_micro,
    ).toBe('0');
  });

  it('rejects a caller that substitutes an unrelated cap', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    const decoyId = uuid();
    await db.withTenant(TENANT, (tx) =>
      createBudget(tx, {
        id: decoyId,
        scopeKind: 'venture',
        scopeId: uuid(),
        currency: 'USD',
        limitMicro: '999999999',
        paused: false,
      }),
    );
    const substituted = [...budgetIds.slice(0, 2), decoyId];
    await expect(
      db.withTenant(TENANT, (tx) =>
        reserveBudget(tx, {
          scanId,
          operationKey: `sub:${scanId}`,
          requestHash: HASH,
          currency: 'USD',
          amountMicro: '100',
          budgetIds: substituted,
        }),
      ),
    ).rejects.toMatchObject({ code: 'MISSING_BUDGET' });
  });

  it('increments every applicable scope by the reserved amount', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: `op:${scanId}`,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '250000',
        budgetIds,
      }),
    );
    const budgets = await db.withTenant(TENANT, (tx) => listBudgets(tx));
    for (const id of budgetIds) {
      expect(budgets.find((b) => b.id === id)!.reserved_micro).toBe('250000');
    }
  });

  it('is unaffected by the order the scope ids are supplied in', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    const reversed = [...budgetIds].reverse();
    await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: `op:${scanId}`,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '1000',
        budgetIds: reversed,
      }),
    );
    const budgets = await db.withTenant(TENANT, (tx) => listBudgets(tx));
    expect(
      budgets.find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!.reserved_micro,
    ).toBe('1000');
  });

  it('refuses a currency the cap does not use', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    await expect(
      db.withTenant(TENANT, (tx) =>
        reserveBudget(tx, {
          scanId,
          operationKey: `op:${scanId}`,
          requestHash: HASH,
          currency: 'EUR',
          amountMicro: '1000',
          budgetIds,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
  });

  it('refuses while a covering cap is paused', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    await db.withTenant(TENANT, async (tx) => {
      const tenantBudget = (await listBudgets(tx)).find((b) => b.scope_kind === 'tenant')!;
      await setBudgetPaused(tx, {
        budgetId: tenantBudget.id,
        expectedVersion: tenantBudget.version,
        paused: true,
      });
    });
    await expect(
      db.withTenant(TENANT, (tx) =>
        reserveBudget(tx, {
          scanId,
          operationKey: `op:${scanId}`,
          requestHash: HASH,
          currency: 'USD',
          amountMicro: '1',
          budgetIds,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_PAUSED' });
  });
});

describe('idempotency', () => {
  it('returns the original reservation for an identical retry', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    const key = `op:${scanId}`;
    const first = await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: key,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '500',
        budgetIds,
      }),
    );
    const second = await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: key,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '500',
        budgetIds,
      }),
    );
    expect(second.replayed).toBe(true);
    expect(second.reservationId).toBe(first.reservationId);
    const budgets = await db.withTenant(TENANT, (tx) => listBudgets(tx));
    // The amount is reserved once, not twice.
    expect(
      budgets.find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!.reserved_micro,
    ).toBe('500');
  });

  it('rejects the same key with a different amount', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    const key = `op:${scanId}`;
    await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: key,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '500',
        budgetIds,
      }),
    );
    await expect(
      db.withTenant(TENANT, (tx) =>
        reserveBudget(tx, {
          scanId,
          operationKey: key,
          requestHash: HASH,
          currency: 'USD',
          amountMicro: '900',
          budgetIds,
        }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects the same key with a different request hash', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    const key = `op:${scanId}`;
    await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: key,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '500',
        budgetIds,
      }),
    );
    await expect(
      db.withTenant(TENANT, (tx) =>
        reserveBudget(tx, {
          scanId,
          operationKey: key,
          requestHash: 'b'.repeat(64),
          currency: 'USD',
          amountMicro: '500',
          budgetIds,
        }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('concurrency at the cap', () => {
  it('admits only one of two simultaneous reservations that would both fit alone', async () => {
    // The scan cap is the binding constraint; the seeded tenant and venture caps are wide.
    const { scanId, budgetIds } = await scanWithCap('100');
    const scanBudgetId = await db.withTenant(
      TENANT,
      async (tx) =>
        (await listBudgets(tx)).find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!.id,
    );

    const attempt = (key: string) =>
      db
        .withTenant(TENANT, (tx) =>
          reserveBudget(tx, {
            scanId,
            operationKey: key,
            requestHash: HASH,
            currency: 'USD',
            amountMicro: '60',
            budgetIds,
          }),
        )
        .then(
          () => 'admitted' as const,
          (error) => (error as { code?: string }).code ?? 'error',
        );

    const [a, b] = await Promise.all([attempt(`race:${scanId}:1`), attempt(`race:${scanId}:2`)]);
    expect([a, b].sort()).toEqual(['BUDGET_EXCEEDED', 'admitted']);

    const budget = await db.withTenant(TENANT, (tx) => getBudget(tx, scanBudgetId));
    // The invariant holds in the database, not just in the API answer.
    expect(budget!.reserved_micro).toBe('60');
    expect(BigInt(budget!.reserved_micro) + BigInt(budget!.settled_micro)).toBeLessThanOrEqual(
      BigInt(budget!.limit_micro),
    );
  });

  it('keeps the cap invariant across many parallel attempts', async () => {
    const { scanId, budgetIds } = await scanWithCap('500');
    const scanBudgetId = await db.withTenant(
      TENANT,
      async (tx) =>
        (await listBudgets(tx)).find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!.id,
    );

    const attempts = Array.from({ length: 12 }, (_, i) =>
      db
        .withTenant(TENANT, (tx) =>
          reserveBudget(tx, {
            scanId,
            operationKey: `burst:${scanId}:${i}`,
            requestHash: HASH,
            currency: 'USD',
            amountMicro: '100',
            budgetIds,
          }),
        )
        .then(
          () => true,
          () => false,
        ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter(Boolean)).toHaveLength(5);

    const budget = await db.withTenant(TENANT, (tx) => getBudget(tx, scanBudgetId));
    expect(budget!.reserved_micro).toBe('500');
  });

  it('leaves no partial allocation when the transaction rolls back after the reservation', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    await expect(
      db.withTenant(TENANT, async (tx) => {
        await reserveBudget(tx, {
          scanId,
          operationKey: `rollback:${scanId}`,
          requestHash: HASH,
          currency: 'USD',
          amountMicro: '400',
          budgetIds,
        });
        throw new Error('deliberate failure after reserving');
      }),
    ).rejects.toThrow('deliberate failure');

    const budgets = await db.withTenant(TENANT, (tx) => listBudgets(tx));
    expect(
      budgets.find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!.reserved_micro,
    ).toBe('0');
    const reservations = await db.withTenant(TENANT, (tx) =>
      tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM oe.reservations WHERE operation_key = $1',
        [`rollback:${scanId}`],
      ),
    );
    expect(reservations.rows[0]!.n).toBe(0);
  });
});

describe('settlement', () => {
  it('moves reserved to settled and is idempotent', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    const key = `settle:${scanId}`;
    await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: key,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '800',
        budgetIds,
      }),
    );
    const first = await db.withTenant(TENANT, (tx) =>
      settleReservation(tx, { operationKey: key, actualMicro: '300', providerRequestId: 'prov-1' }),
    );
    expect(first.overrun).toBe(false);

    const budgets = await db.withTenant(TENANT, (tx) => listBudgets(tx));
    const scanBudget = budgets.find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!;
    expect(scanBudget.reserved_micro).toBe('0');
    expect(scanBudget.settled_micro).toBe('300');
    expect(scanBudget.paused).toBe(false);

    const replay = await db.withTenant(TENANT, (tx) =>
      settleReservation(tx, { operationKey: key, actualMicro: '300', providerRequestId: 'prov-1' }),
    );
    expect(replay.replayed).toBe(true);
    const after = await db.withTenant(TENANT, (tx) => listBudgets(tx));
    expect(after.find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!.settled_micro).toBe(
      '300',
    );
  });

  it('rejects a second settlement with a different amount', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    const key = `settle2:${scanId}`;
    await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: key,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '800',
        budgetIds,
      }),
    );
    await db.withTenant(TENANT, (tx) =>
      settleReservation(tx, { operationKey: key, actualMicro: '300', providerRequestId: null }),
    );
    await expect(
      db.withTenant(TENANT, (tx) =>
        settleReservation(tx, { operationKey: key, actualMicro: '400', providerRequestId: null }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('records a provider overrun as real spend and pauses the scope', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    const key = `overrun:${scanId}`;
    await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: key,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '100',
        budgetIds,
      }),
    );
    const result = await db.withTenant(TENANT, (tx) =>
      settleReservation(tx, {
        operationKey: key,
        actualMicro: '750',
        providerRequestId: 'prov-over',
      }),
    );
    expect(result.overrun).toBe(true);

    const budgets = await db.withTenant(TENANT, (tx) => listBudgets(tx));
    // The real cost is recorded, not discarded to keep the invariant looking clean.
    expect(
      budgets.find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!.settled_micro,
    ).toBe('750');
    // Every covering scope stops admitting new work, not only the one that overran.
    for (const id of budgetIds) {
      expect(budgets.find((b) => b.id === id)!.paused).toBe(true);
    }
  });

  it('refuses to resume a scope whose committed spend still exceeds its limit', async () => {
    const { scanId, budgetIds } = await scanWithCap('200');
    const key = `resume:${scanId}`;
    await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: key,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '100',
        budgetIds,
      }),
    );
    await db.withTenant(TENANT, (tx) =>
      settleReservation(tx, { operationKey: key, actualMicro: '900', providerRequestId: null }),
    );
    const scanBudget = await db.withTenant(TENANT, async (tx) =>
      (await listBudgets(tx)).find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!,
    );
    await expect(
      db.withTenant(TENANT, (tx) =>
        setBudgetPaused(tx, {
          budgetId: scanBudget.id,
          expectedVersion: scanBudget.version,
          paused: false,
        }),
      ),
    ).rejects.toMatchObject({ code: 'OVERRUN_NOT_RECONCILED' });
  });

  it('keeps an ambiguous provider result consuming its reserved allowance', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    const key = `uncertain:${scanId}`;
    await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: key,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '600',
        budgetIds,
      }),
    );
    await db.withTenant(TENANT, (tx) => markReservationUncertain(tx, key));

    const budgets = await db.withTenant(TENANT, (tx) => listBudgets(tx));
    expect(
      budgets.find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!.reserved_micro,
    ).toBe('600');

    // A cancellation cannot release it: a timeout is not proof of zero charge.
    await expect(
      db.withTenant(TENANT, (tx) =>
        releaseReservation(tx, { operationKey: key, confirmedNoCharge: false }),
      ),
    ).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });

    // Reconciliation with the provider settles it for real.
    await db.withTenant(TENANT, (tx) =>
      settleReservation(tx, {
        operationKey: key,
        actualMicro: '120',
        providerRequestId: 'prov-recon',
      }),
    );
    const after = await db.withTenant(TENANT, (tx) => listBudgets(tx));
    const scanBudget = after.find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!;
    expect(scanBudget.reserved_micro).toBe('0');
    expect(scanBudget.settled_micro).toBe('120');
  });

  it('releases only when no charge is confirmed, and cannot release settled cost', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    const key = `release:${scanId}`;
    await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: key,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '450',
        budgetIds,
      }),
    );
    await db.withTenant(TENANT, (tx) =>
      releaseReservation(tx, { operationKey: key, confirmedNoCharge: true }),
    );
    const budgets = await db.withTenant(TENANT, (tx) => listBudgets(tx));
    expect(
      budgets.find((b) => b.scope_kind === 'scan' && b.scope_id === scanId)!.reserved_micro,
    ).toBe('0');

    await expect(
      db.withTenant(TENANT, (tx) =>
        settleReservation(tx, { operationKey: key, actualMicro: '1', providerRequestId: null }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('owner configuration', () => {
  it('requires the expected version', async () => {
    const budget = await db.withTenant(TENANT, async (tx) =>
      (await listBudgets(tx)).find((b) => b.scope_kind === 'tenant')!,
    );
    await expect(
      db.withTenant(TENANT, (tx) =>
        configureBudget(tx, {
          budgetId: budget.id,
          expectedVersion: budget.version + 5,
          limitMicro: '9000000',
          currency: 'USD',
        }),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('cannot set a limit below what is already committed', async () => {
    const { scanId, budgetIds } = await scanWithCap('1000000');
    await db.withTenant(TENANT, (tx) =>
      reserveBudget(tx, {
        scanId,
        operationKey: `commit:${scanId}`,
        requestHash: HASH,
        currency: 'USD',
        amountMicro: '400000',
        budgetIds,
      }),
    );
    const tenantBudget = await db.withTenant(TENANT, async (tx) =>
      (await listBudgets(tx)).find((b) => b.scope_kind === 'tenant')!,
    );
    await expect(
      db.withTenant(TENANT, (tx) =>
        configureBudget(tx, {
          budgetId: tenantBudget.id,
          expectedVersion: tenantBudget.version,
          limitMicro: '1000',
          currency: 'USD',
        }),
      ),
    ).rejects.toMatchObject({ code: 'LIMIT_BELOW_COMMITTED' });
  });
});
