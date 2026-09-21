import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getAccount,
  getEvidence,
  insertAccount,
  insertAuditEvent,
  listAccounts,
  resolveMemberships,
  type Database,
} from '@oe/db';
import { freshHarness, LOCAL_FIXTURE, uuid, type Harness } from '../support/harness.ts';

/**
 * ACCEPTANCE.md, tenant isolation: "Two real DB connections/roles cannot read/write/link
 * each other's objects."
 *
 * DATA_MODEL.md is explicit that filtering a list is not the test — a direct lookup by a
 * known UUID and an attempted cross-tenant foreign key are.
 */

let harness: Harness;
let db: Database;

beforeAll(async () => {
  harness = await freshHarness();
  db = harness.db;
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe('runtime role', () => {
  it('is not a superuser and cannot bypass row-level security', async () => {
    const row = await db.withoutTenant(async (tx) => {
      const result = await tx.query<{ usesuper: boolean; bypassrls: boolean; current_user: string }>(
        `SELECT r.rolsuper AS usesuper, r.rolbypassrls AS bypassrls, current_user
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      return result.rows[0]!;
    });
    expect(row.usesuper).toBe(false);
    expect(row.bypassrls).toBe(false);
    expect(row.current_user).not.toBe('oe_migrate');
  });

  it('sees nothing at all without a tenant context', async () => {
    const counts = await db.withoutTenant(async (tx) => {
      const accounts = await tx.query('SELECT count(*)::int AS n FROM oe.accounts');
      const tenants = await tx.query('SELECT count(*)::int AS n FROM oe.tenants');
      return {
        accounts: (accounts.rows[0] as { n: number }).n,
        tenants: (tenants.rows[0] as { n: number }).n,
      };
    });
    expect(counts).toEqual({ accounts: 0, tenants: 0 });
  });

  it('cannot write the budget tables directly', async () => {
    await expect(
      db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
        tx.query('UPDATE oe.budgets SET limit_micro = 999999999 WHERE scope_kind = $1', ['tenant']),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
        tx.query(
          `INSERT INTO oe.reservations (tenant_id, id, scan_id, operation_key, request_hash, currency, reserved_micro, state)
           VALUES (oe.tenant_context(), gen_random_uuid(), gen_random_uuid(), 'k', repeat('a', 64), 'USD', 1, 'reserved')`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot edit an immutable review row or a report snapshot', async () => {
    await expect(
      db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
        tx.query("UPDATE oe.reviews SET reason = 'rewritten'"),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
        tx.query("UPDATE oe.reports SET snapshot = '{}'::jsonb"),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot delete audit history', async () => {
    await expect(
      db.withTenant(LOCAL_FIXTURE.tenantA, (tx) => tx.query('DELETE FROM oe.audit_events')),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot alter an evidence observation, only its retention metadata', async () => {
    await expect(
      db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
        tx.query("UPDATE oe.evidence SET http_status = 200"),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // Redaction and expiry remain writable, which is what the deletion workflow needs.
    await expect(
      db.withTenant(LOCAL_FIXTURE.tenantA, (tx) => tx.query('UPDATE oe.evidence SET redacted = true')),
    ).resolves.toBeDefined();
  });
});

describe('cross-tenant access', () => {
  it('cannot read another tenant’s account even with its exact UUID', async () => {
    const own = await db.withTenant(LOCAL_FIXTURE.tenantA, (tx) => getAccount(tx, LOCAL_FIXTURE.accountA));
    expect(own?.id).toBe(LOCAL_FIXTURE.accountA);

    const foreign = await db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
      getAccount(tx, LOCAL_FIXTURE.accountB),
    );
    expect(foreign).toBeNull();
  });

  it('cannot link a foreign venture into its own account row', async () => {
    await expect(
      db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
        insertAccount(tx, {
          id: uuid(),
          // Tenant B's venture: the composite foreign key includes tenant_id, so this is
          // rejected rather than silently creating a cross-tenant link.
          ventureId: LOCAL_FIXTURE.ventureB,
          name: 'Smuggled',
          canonicalDomain: 'smuggled.test',
          approvedHosts: ['smuggled.test'],
          sourceNote: 'attempt',
        }),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('cannot write a row tagged with another tenant id', async () => {
    await expect(
      db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
        tx.query(
          `INSERT INTO oe.assets (tenant_id, id, account_id, canonical_url)
           VALUES ($1, gen_random_uuid(), $2, 'https://x.test/p')`,
          [LOCAL_FIXTURE.tenantB, LOCAL_FIXTURE.accountB],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot fetch another tenant’s evidence row by id', async () => {
    const evidenceId = await db.withTenant(LOCAL_FIXTURE.tenantB, async (tx) => {
      const asset = await tx.query<{ id: string }>(
        `INSERT INTO oe.assets (tenant_id, id, account_id, canonical_url)
         VALUES (oe.tenant_context(), gen_random_uuid(), $1, 'https://modewerk.test/p') RETURNING id`,
        [LOCAL_FIXTURE.accountB],
      );
      const scan = await tx.query<{ id: string }>(
        `INSERT INTO oe.scans (tenant_id, id, account_id, venture_id, authorization_id, target_url,
           state, version, expected_unique_pages, requested_by)
         VALUES (oe.tenant_context(), gen_random_uuid(), $1, $2, $3, 'https://modewerk.test/p',
           'queued', 1, 2, $4) RETURNING id`,
        [LOCAL_FIXTURE.accountB, LOCAL_FIXTURE.ventureB, LOCAL_FIXTURE.authorizationB, LOCAL_FIXTURE.ownerB],
      );
      const evidence = await tx.query<{ id: string }>(
        `INSERT INTO oe.evidence (tenant_id, id, scan_id, asset_id, kind, source_url, final_url,
           sha256, conditions, http_status, complete, captured_at, expires_at)
         VALUES (oe.tenant_context(), gen_random_uuid(), $1, $2, 'http_observation',
           'https://modewerk.test/p', 'https://modewerk.test/p', repeat('b', 64), '{}'::jsonb,
           200, true, now(), now() + interval '30 days') RETURNING id`,
        [scan.rows[0]!.id, asset.rows[0]!.id],
      );
      return evidence.rows[0]!.id;
    });

    const leaked = await db.withTenant(LOCAL_FIXTURE.tenantA, (tx) => getEvidence(tx, evidenceId));
    expect(leaked).toBeNull();
  });

  it('lists only the caller’s own accounts', async () => {
    const rows = await db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
      listAccounts(tx, { ventureIds: [LOCAL_FIXTURE.ventureA, LOCAL_FIXTURE.ventureB], limit: 50, cursor: null }),
    );
    expect(rows.map((r) => r.id)).toContain(LOCAL_FIXTURE.accountA);
    expect(rows.map((r) => r.id)).not.toContain(LOCAL_FIXTURE.accountB);
  });
});

describe('transaction-local tenant context', () => {
  it('does not survive into the next checkout of the same pooled connection', async () => {
    // Force reuse of a single connection so a leaked GUC would be observable.
    const single = new (await import('@oe/db')).Database({
      connectionString: process.env.DATABASE_URL!,
      max: 1,
      applicationName: 'oe-test-pool-reuse',
    });
    try {
      await single.withTenant(LOCAL_FIXTURE.tenantA, async (tx) => {
        const seen = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM oe.accounts');
        expect(seen.rows[0]!.n).toBeGreaterThan(0);
      });
      const after = await single.withoutTenant(async (tx) => {
        const context = await tx.query<{ context: string | null }>(
          "SELECT nullif(current_setting('oe.tenant_id', true), '') AS context",
        );
        const accounts = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM oe.accounts');
        return { context: context.rows[0]!.context, accounts: accounts.rows[0]!.n };
      });
      expect(after.context).toBeNull();
      expect(after.accounts).toBe(0);
    } finally {
      await single.close();
    }
  });

  it('rolls the context back with the transaction when it fails', async () => {
    await expect(
      db.withTenant(LOCAL_FIXTURE.tenantA, async (tx) => {
        await insertAuditEvent(tx, {
          id: uuid(),
          actorSubject: 'test',
          action: 'test.rollback',
          objectType: 'test',
          objectId: uuid(),
          objectVersion: null,
          requestId: 'r',
          detail: {},
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    const rows = await db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
      tx.query<{ n: number }>("SELECT count(*)::int AS n FROM oe.audit_events WHERE action = 'test.rollback'"),
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('refuses a tenant identifier that is not a UUID', async () => {
    await expect(db.withTenant("' OR 1=1 --", async () => undefined)).rejects.toThrow(TypeError);
  });
});

describe('identity resolution', () => {
  it('resolves a verified subject to its membership and ventures', async () => {
    const memberships = await harness.identityDb.withoutTenant((tx) =>
      resolveMemberships(tx, LOCAL_FIXTURE.issuer, 'operator@fixture.test'),
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ tenantId: LOCAL_FIXTURE.tenantA, role: 'operator' });
    // The identity role cannot read oe.tenants, so the currency is not resolved here.
    expect(memberships[0]!.ledgerCurrency).toBe('');
    expect(memberships[0]!.ventureIds).toContain(LOCAL_FIXTURE.ventureA);
  });

  it('returns nothing for an unknown subject', async () => {
    const memberships = await harness.identityDb.withoutTenant((tx) =>
      resolveMemberships(tx, LOCAL_FIXTURE.issuer, 'stranger@fixture.test'),
    );
    expect(memberships).toEqual([]);
  });

  it('stops resolving a membership that was deactivated', async () => {
    await harness.db.withTenant(LOCAL_FIXTURE.tenantA, async () => undefined);
    const migrationClient = new (await import('pg')).default.Client({
      connectionString: process.env.MIGRATION_DATABASE_URL!,
    });
    await migrationClient.connect();
    try {
      await migrationClient.query('SELECT set_config($1, $2, false)', ['oe.tenant_id', LOCAL_FIXTURE.tenantA]);
      await migrationClient.query('UPDATE oe.memberships SET active = false WHERE id = $1', [
        LOCAL_FIXTURE.viewerA,
      ]);
      const memberships = await harness.identityDb.withoutTenant((tx) =>
        resolveMemberships(tx, LOCAL_FIXTURE.issuer, 'viewer@fixture.test'),
      );
      expect(memberships).toEqual([]);
    } finally {
      await migrationClient.query('UPDATE oe.memberships SET active = true WHERE id = $1', [
        LOCAL_FIXTURE.viewerA,
      ]).catch(() => undefined);
      await migrationClient.end();
    }
  });
});
