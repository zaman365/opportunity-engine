import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database, QueryExecutor } from '@oe/db';
import pg from 'pg';
import {
  freshHarness,
  LOCAL_FIXTURE,
  requireDatabaseUrls,
  uuid,
  type Harness,
} from '../support/harness.ts';

/**
 * The gate that keeps CE-CONTENT-01 and CE-VISUAL-01 unrequestable.
 *
 * These two rules apply a standard somebody has to sign, and migration 0017 makes that a
 * database constraint rather than a convention in the service layer. The tests below go
 * straight to SQL for exactly that reason: a control that only holds when the application
 * remembers to check it is not a control, and the way to prove it is to skip the application.
 */

let harness: Harness;
let db: Database;

const TENANT = LOCAL_FIXTURE.tenantA;

beforeAll(async () => {
  harness = await freshHarness();
  db = harness.db;
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

async function insertScan(
  tx: QueryExecutor,
  detectors: string[],
  rubricKey: string | null,
): Promise<string> {
  const id = uuid();
  await tx.query(
    `INSERT INTO oe.scans (tenant_id, id, account_id, venture_id, authorization_id, target_url,
       state, version, expected_unique_pages, requested_by, detectors, rubric_key)
     VALUES (oe.tenant_context(), $1, $2, $3, $4, 'https://atelier-nord.test/product',
       'queued', 1, 2, $5, $6, $7)`,
    [
      id,
      LOCAL_FIXTURE.accountA,
      LOCAL_FIXTURE.ventureA,
      LOCAL_FIXTURE.authorizationA,
      LOCAL_FIXTURE.operatorA,
      detectors,
      rubricKey,
    ],
  );
  return id;
}

describe('the rubric gate', () => {
  it('lets the four unGated rules through with no rubric named', async () => {
    await db.withTenant(TENANT, async (tx) => {
      const id = await insertScan(
        tx,
        ['CE-LINK-01', 'CE-ASSET-01', 'CE-DATA-01', 'CE-MOBILE-01'],
        null,
      );
      expect(id).toBeTruthy();
    });
  });

  for (const detector of ['CE-CONTENT-01', 'CE-VISUAL-01']) {
    it(`refuses ${detector} when no rubric is named`, async () => {
      await expect(db.withTenant(TENANT, (tx) => insertScan(tx, [detector], null))).rejects.toThrow(
        /scans_rubric_detectors_require_rubric/,
      );
    });

    it(`refuses ${detector} when the named rubric does not exist`, async () => {
      // The realistic failure: somebody writes a rubric file, does not get it approved, and
      // wires the key through anyway. There is no row, so there is no scan.
      await expect(
        db.withTenant(TENANT, (tx) => insertScan(tx, [detector], 'apparel-everyday-layers')),
      ).rejects.toThrow(/scans_rubric_key_fkey/);
    });
  }

  it('refuses a gated rule hidden among ungated ones', async () => {
    // The constraint is written with `&&` rather than `<@`, so one gated rule in a list of
    // four is still caught. A scan that slipped through here would produce a finding judged
    // against a standard nobody approved.
    await expect(
      db.withTenant(TENANT, (tx) => insertScan(tx, ['CE-LINK-01', 'CE-CONTENT-01'], null)),
    ).rejects.toThrow(/scans_rubric_detectors_require_rubric/);
  });

  it('still refuses a rule this build does not implement at all', async () => {
    await expect(
      db.withTenant(TENANT, (tx) => insertScan(tx, ['CE-NONSENSE-01'], null)),
    ).rejects.toThrow(/scans_detectors_supported/);
  });
});

describe('oe.category_rubrics holds approved rubrics only', () => {
  /**
   * Written through the migration role, because the runtime role deliberately cannot write
   * here at all -- a rubric is approved out of band and loaded by the seeder, exactly as the
   * offer catalogue is. The application that applies a standard is not the application that
   * gets to write one. The test immediately below proves that half.
   */
  async function withMigrationClient<T>(fn: (query: Query) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: requireDatabaseUrls().migration });
    await client.connect();
    try {
      await client.query('SELECT set_config($1, $2, false)', ['oe.tenant_id', TENANT]);
      return await fn((text, values) => client.query(text, values));
    } finally {
      await client.end();
    }
  }

  type Query = (text: string, values?: unknown[]) => Promise<unknown>;

  function insertRubric(
    query: Query,
    overrides: {
      approvedBy?: string | null;
      approvedAt?: string | null;
      contested?: string[];
    } = {},
  ): Promise<unknown> {
    return query(
      `INSERT INTO oe.category_rubrics
         (tenant_id, id, rubric_key, label, document, contested, approved_by, approved_at)
       VALUES ($1, $2, $3, 'Everyday layers', '{}'::jsonb, $4, $5, $6)`,
      [
        TENANT,
        uuid(),
        `test-${Math.random().toString(36).slice(2, 10)}`,
        overrides.contested ?? ['whether a fit description is buying information'],
        overrides.approvedBy === undefined ? LOCAL_FIXTURE.operatorA : overrides.approvedBy,
        overrides.approvedAt === undefined ? new Date().toISOString() : overrides.approvedAt,
      ],
    );
  }

  it('does not let the runtime role write a rubric at all', async () => {
    await expect(
      db.withTenant(TENANT, (tx) =>
        tx.query(
          `INSERT INTO oe.category_rubrics
             (tenant_id, id, rubric_key, label, document, contested, approved_by, approved_at)
           VALUES (oe.tenant_context(), $1, 'smuggled', 'x', '{}'::jsonb, ARRAY['x'], $2, now())`,
          [uuid(), LOCAL_FIXTURE.operatorA],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('accepts a rubric with a named approver and a time', async () => {
    await withMigrationClient((query) => insertRubric(query));
  });

  it('refuses a rubric with no approver', async () => {
    await expect(
      withMigrationClient((query) => insertRubric(query, { approvedBy: null })),
    ).rejects.toThrow(/approved_by/);
  });

  it('refuses a rubric with no time of approval', async () => {
    await expect(
      withMigrationClient((query) => insertRubric(query, { approvedAt: null })),
    ).rejects.toThrow(/approved_at/);
  });

  it('refuses a rubric that declares nothing contested', async () => {
    // Not pedantry. Every finding carries this list as what the rule declined to judge, and a
    // rubric whose author found nothing arguable has not finished arguing.
    await expect(
      withMigrationClient((query) => insertRubric(query, { contested: [] })),
    ).rejects.toThrow(/contested/);
  });

  it('keeps one live standard per category, and opens the gate once it exists', async () => {
    const key = `apparel-${Math.random().toString(36).slice(2, 10)}`;
    const write = (query: Query) =>
      query(
        `INSERT INTO oe.category_rubrics
           (tenant_id, id, rubric_key, label, document, contested, approved_by, approved_at)
         VALUES ($1, $2, $3, 'Everyday layers', '{}'::jsonb, ARRAY['x'], $4, now())`,
        [TENANT, uuid(), key, LOCAL_FIXTURE.operatorA],
      );
    await withMigrationClient(write);
    await expect(withMigrationClient(write)).rejects.toThrow(
      /category_rubrics_tenant_id_rubric_key_key/,
    );

    // And the other half of the gate: with an approved rubric in place, the rule this build
    // has been refusing all along goes through. The constraint gates on approval, not on the
    // detector being unwelcome.
    await db.withTenant(TENANT, async (tx) => {
      const id = await insertScan(tx, ['CE-CONTENT-01', 'CE-VISUAL-01'], key);
      expect(id).toBeTruthy();
    });
  });
});
