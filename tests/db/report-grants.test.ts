import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveReportGrant, type Database } from '@oe/db';
import {
  freshHarness,
  LOCAL_FIXTURE,
  requireDatabaseUrls,
  uuid,
  type Harness,
} from '../support/harness.ts';

/**
 * What the database enforces about a protected link, independently of the application.
 *
 * Two of these cannot be reached from a request at all: what the identity role may see while
 * resolving a token, and what the runtime role is forbidden from changing afterwards. Both are
 * privileges, so they are tested as privileges — an application bug must not be able to extend
 * a link's life or point it at a different report.
 */

let harness: Harness;
let db: Database;
let identityDb: Database;
let reportId: string;

const TENANT_A = LOCAL_FIXTURE.tenantA;

beforeAll(async () => {
  harness = await freshHarness();
  db = harness.db;
  identityDb = harness.identityDb;

  // A published report to hang grants on. Written through the migration role, because this
  // suite is about the grant table rather than about how a report gets published.
  reportId = uuid();
  const client = new pg.Client({ connectionString: requireDatabaseUrls().migration });
  await client.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['oe.tenant_id', TENANT_A]);
    await client.query(
      `INSERT INTO oe.reports
         (tenant_id, id, account_id, scan_id, state, version, language, audience, snapshot,
          published_at)
       VALUES ($1, $2, $3, $4, 'published', 3, 'en', 'internal_tenant', '{}'::jsonb, now())`,
      [TENANT_A, reportId, LOCAL_FIXTURE.accountA, await someScan(client)],
    );
  } finally {
    await client.end();
  }
}, 120_000);

async function someScan(client: pg.Client): Promise<string> {
  const id = uuid();
  await client.query(
    `INSERT INTO oe.scans (tenant_id, id, account_id, venture_id, authorization_id, target_url,
       state, version, expected_unique_pages, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'https://atelier-nord.test/p', 'succeeded', 1, 2, $6)`,
    [
      TENANT_A,
      id,
      LOCAL_FIXTURE.accountA,
      LOCAL_FIXTURE.ventureA,
      LOCAL_FIXTURE.authorizationA,
      LOCAL_FIXTURE.ownerA,
    ],
  );
  return id;
}

afterAll(async () => {
  await harness?.close();
});

async function insertGrant(
  over: Record<string, unknown> = {},
): Promise<{ id: string; hash: Buffer }> {
  const id = uuid();
  const hash =
    (over['token_hash'] as Buffer) ??
    Buffer.from(uuid().replaceAll('-', '') + uuid().replaceAll('-', ''), 'hex');
  await db.withTenant(TENANT_A, (tx) =>
    tx.query(
      `INSERT INTO oe.report_grants
         (tenant_id, id, report_id, report_version, token_hash, audience, recipient_hash,
          recipient_note, expires_at, created_by)
       VALUES (oe.tenant_context(), $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9)`,
      [
        id,
        reportId,
        over['report_version'] ?? 3,
        hash,
        over['audience'] ?? 'report_access',
        Buffer.alloc(32, 9),
        'fixture recipient',
        // Computed here rather than as SQL: a parameter is a value, and passing an
        // expression as one is how a test ends up asserting about its own string.
        new Date(
          Date.now() + ((over['expiresInSeconds'] as number) ?? 14 * 86_400) * 1000,
        ).toISOString(),
        LOCAL_FIXTURE.ownerA,
      ],
    ),
  );
  return { id, hash };
}

describe('resolving a token', () => {
  it('answers with no tenant context, because the tenant is what it answers', async () => {
    const { hash } = await insertGrant();
    const grant = await identityDb.withoutTenant((tx) => resolveReportGrant(tx, hash));
    expect(grant?.tenant_id).toBe(TENANT_A);
    expect(grant?.report_id).toBe(reportId);
  });

  it('cannot see a revoked grant at all', async () => {
    // The policy is narrower than the query, so "revoked" and "never existed" are already the
    // same answer before any application code could tell them apart.
    const { id, hash } = await insertGrant();
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(
        `UPDATE oe.report_grants SET revoked_at = now(), revoke_reason = 'x', revoked_by = $2
          WHERE id = $1`,
        [id, LOCAL_FIXTURE.ownerA],
      ),
    );
    expect(await identityDb.withoutTenant((tx) => resolveReportGrant(tx, hash))).toBeNull();
  });

  it('cannot see an expired grant at all', async () => {
    const { hash } = await insertGrant({ expiresInSeconds: -1 });
    expect(await identityDb.withoutTenant((tx) => resolveReportGrant(tx, hash))).toBeNull();
  });

  it('refuses two grants sharing a token hash', async () => {
    // Global, not per tenant: the lookup that resolves a token has no tenant to scope by.
    const { hash } = await insertGrant();
    await expect(insertGrant({ token_hash: hash })).rejects.toThrow(/report_grants_token/);
  });
});

describe('what the runtime role may not do', () => {
  it('cannot extend or shorten a link it already issued', async () => {
    // The lifetime somebody was given is the lifetime they have. A runtime path that could
    // move it would make "expires in 14 days" a statement about intent rather than fact.
    const { id } = await insertGrant();
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `UPDATE oe.report_grants SET expires_at = now() + interval '10 years' WHERE id = $1`,
          [id],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot repoint a link at a different report or version', async () => {
    const { id } = await insertGrant();
    for (const [statement, params] of [
      ['UPDATE oe.report_grants SET report_version = 99 WHERE id = $1', [id]],
      ['UPDATE oe.report_grants SET token_hash = $2 WHERE id = $1', [id, Buffer.alloc(32, 3)]],
      ['UPDATE oe.report_grants SET report_id = $1 WHERE id = $1', [id]],
    ] as const) {
      await expect(
        db.withTenant(TENANT_A, (tx) => tx.query(statement, [...params])),
        statement,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('cannot delete a grant, only revoke it', async () => {
    const { id } = await insertGrant();
    await expect(
      db.withTenant(TENANT_A, (tx) => tx.query('DELETE FROM oe.report_grants WHERE id = $1', [id])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('constraints', () => {
  it('refuses a token minted for another purpose', async () => {
    await expect(insertGrant({ audience: 'intake_verification' })).rejects.toThrow(
      /report_grants_audience_check/,
    );
  });

  it('refuses a revocation with no reason, and a reason with no revocation', async () => {
    const { id } = await insertGrant();
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query('UPDATE oe.report_grants SET revoked_at = now() WHERE id = $1', [id]),
      ),
    ).rejects.toThrow(/report_grants_check/);
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query("UPDATE oe.report_grants SET revoke_reason = 'why' WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/report_grants_check/);
  });

  it('will not let one workspace read another workspace grants', async () => {
    const { id } = await insertGrant();
    const seen = await db.withTenant(LOCAL_FIXTURE.tenantB, (tx) =>
      tx.query('SELECT id FROM oe.report_grants WHERE id = $1', [id]),
    );
    expect(seen.rows).toEqual([]);
  });
});
