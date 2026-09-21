import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countRateLimitHit,
  insertIntakeRequest,
  insertIntakeVerification,
  resolveIntakeChannel,
  sweepRateLimits,
  type Database,
} from '@oe/db';
import {
  freshHarness,
  LOCAL_FIXTURE,
  requireDatabaseUrls,
  uuid,
  type Harness,
} from '../support/harness.ts';

/**
 * The database half of the public surface.
 *
 * Two things are checked here that no request test can reach: what the identity role may see
 * while resolving a host to a workspace, and what the runtime role is prevented from doing to
 * the rate-limit counters. Both are privileges, so they are tested as privileges.
 */

let harness: Harness;
let db: Database;
let identityDb: Database;

beforeAll(async () => {
  harness = await freshHarness();
  db = harness.db;
  identityDb = harness.identityDb;
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

const TENANT_A = LOCAL_FIXTURE.tenantA;
const TENANT_B = LOCAL_FIXTURE.tenantB;

describe('resolving a host to a workspace', () => {
  it('answers with no tenant context, which is the whole point', async () => {
    // The tenant is the answer to this lookup, so it cannot also be its precondition.
    const channel = await identityDb.withoutTenant((tx) =>
      resolveIntakeChannel(tx, 'intake-a.fixture.test'),
    );
    expect(channel?.tenant_id).toBe(TENANT_A);
    expect(channel?.venture_id).toBe(LOCAL_FIXTURE.ventureA);
  });

  it('sends two hosts to two different workspaces', async () => {
    const b = await identityDb.withoutTenant((tx) =>
      resolveIntakeChannel(tx, 'intake-b.fixture.test'),
    );
    expect(b?.tenant_id).toBe(TENANT_B);
  });

  it('answers nothing for a host nobody registered', async () => {
    const none = await identityDb.withoutTenant((tx) =>
      resolveIntakeChannel(tx, 'unknown.example.com'),
    );
    expect(none).toBeNull();
  });

  it('does not let the runtime role register a public hostname at all', async () => {
    // Registering a host decides where strangers' submissions land, so it is a bootstrap act
    // like adding a member — not something a request can do. The runtime role holds SELECT
    // and `UPDATE (enabled)` and nothing else.
    await expect(
      db.withTenant(TENANT_B, (tx) =>
        tx.query(
          `INSERT INTO oe.intake_channels
             (tenant_id, id, venture_id, host, enabled, purpose_text, allowed_detectors,
              daily_request_limit, created_by)
           VALUES ($1, $2, $3, 'brand-new.example.com', true, $4, ARRAY['MF-LINK-01'], 10, $5)`,
          [
            TENANT_B,
            uuid(),
            LOCAL_FIXTURE.ventureB,
            'A hostname a runtime request should never be able to claim for itself.',
            LOCAL_FIXTURE.ownerB,
          ],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses a second workspace claim on one hostname, even from the owner procedure', async () => {
    // Two claims on one host would make the tenant of an incoming request ambiguous, which is
    // the one thing the channel table exists to decide. Asserted against the migration role,
    // because that is who registers a channel.
    const client = new pg.Client({ connectionString: requireDatabaseUrls().migration });
    await client.connect();
    try {
      // Session-local, not transaction-local: there is no surrounding transaction here, and
      // a transaction-local setting would revert before the insert ran — which reads as an
      // RLS refusal and would have hidden the constraint this test is about.
      await client.query('SELECT set_config($1, $2, false)', ['oe.tenant_id', TENANT_B]);
      await expect(
        client.query(
          `INSERT INTO oe.intake_channels
             (tenant_id, id, venture_id, host, enabled, purpose_text, allowed_detectors,
              daily_request_limit, created_by)
           VALUES ($1, $2, $3, 'intake-a.fixture.test', true, $4, ARRAY['MF-LINK-01'], 10, $5)`,
          [
            TENANT_B,
            uuid(),
            LOCAL_FIXTURE.ventureB,
            'A duplicate claim on another workspace public hostname, forty characters long.',
            LOCAL_FIXTURE.ownerB,
          ],
        ),
      ).rejects.toThrow(/intake_channels_host/);
    } finally {
      await client.end();
    }
  });

  it('shows the runtime role only its own workspace channels', async () => {
    const rows = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ host: string }>('SELECT host FROM oe.intake_channels'),
    );
    expect(rows.rows.map((r) => r.host)).toEqual(['intake-a.fixture.test']);
  });
});

describe('requests', () => {
  async function insert(tenantId: string, ventureId: string, channelId: string): Promise<string> {
    const id = uuid();
    await db.withTenant(tenantId, (tx) =>
      insertIntakeRequest(tx, {
        id,
        channelId,
        ventureId,
        targetUrl: 'https://shop.example.com/p',
        targetHost: 'shop.example.com',
        requestedDetectors: ['MF-LINK-01'],
        purpose: 'The linked size guide looks broken.',
        authorityClaim: 'I run this shop and I am asking for this myself.',
        agreedPurposeVersion: 1,
        contactEmail: 'requester@example.com',
        contactEmailHash: Buffer.alloc(32, 7),
        expiresAt: '2026-10-21T00:00:00Z',
      }),
    );
    return id;
  }

  it('starts unverified and without marketing consent', async () => {
    const id = await insert(TENANT_A, LOCAL_FIXTURE.ventureA, LOCAL_FIXTURE.intakeChannelA);
    const row = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ state: string; marketing_consent: boolean }>(
        'SELECT state, marketing_consent FROM oe.intake_requests WHERE id = $1',
        [id],
      ),
    );
    expect(row.rows[0]).toEqual({ state: 'pending_verification', marketing_consent: false });
  });

  it('refuses marketing consent with no time recorded against it', async () => {
    // Consent is an act with a moment. A flag on its own is an assertion nobody can date.
    const id = await insert(TENANT_A, LOCAL_FIXTURE.ventureA, LOCAL_FIXTURE.intakeChannelA);
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query('UPDATE oe.intake_requests SET marketing_consent = true WHERE id = $1', [id]),
      ),
    ).rejects.toThrow(/intake_requests_check/);
  });

  it('refuses a verified state with no verification time', async () => {
    const id = await insert(TENANT_A, LOCAL_FIXTURE.ventureA, LOCAL_FIXTURE.intakeChannelA);
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query("UPDATE oe.intake_requests SET state = 'verified' WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/intake_requests_check/);
  });

  it('keeps a verification time after the request is declined', async () => {
    // Verification is a thing that happened, and it stays having happened. An equality
    // constraint here would forbid declining a request that was verified first.
    const id = await insert(TENANT_A, LOCAL_FIXTURE.ventureA, LOCAL_FIXTURE.intakeChannelA);
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(
        `UPDATE oe.intake_requests
            SET state = 'verified', verified_at = now() WHERE id = $1`,
        [id],
      ),
    );
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(
        `UPDATE oe.intake_requests
            SET state = 'declined', decided_at = now(), decided_by = $2, decision_reason = 'x'
          WHERE id = $1`,
        [id, LOCAL_FIXTURE.ownerA],
      ),
    );
    const row = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ verified_at: string | null }>(
        'SELECT verified_at FROM oe.intake_requests WHERE id = $1',
        [id],
      ),
    );
    expect(row.rows[0]!.verified_at).not.toBeNull();
  });

  it('will not let one workspace read another workspace requests', async () => {
    const id = await insert(TENANT_A, LOCAL_FIXTURE.ventureA, LOCAL_FIXTURE.intakeChannelA);
    const seen = await db.withTenant(TENANT_B, (tx) =>
      tx.query('SELECT id FROM oe.intake_requests WHERE id = $1', [id]),
    );
    expect(seen.rows).toEqual([]);
  });

  it('allows one live challenge per request and no more', async () => {
    // A second would double the guesses an attacker gets for one request.
    const id = await insert(TENANT_A, LOCAL_FIXTURE.ventureA, LOCAL_FIXTURE.intakeChannelA);
    const mint = () =>
      db.withTenant(TENANT_A, (tx) =>
        insertIntakeVerification(tx, {
          id: uuid(),
          requestId: id,
          codeHash: Buffer.alloc(32, 1),
          expiresAt: '2026-09-21T14:10:00Z',
          delivery: 'recorded_local_only',
        }),
      );
    await expect(mint()).resolves.toBeTruthy();
    await expect(mint()).rejects.toThrow(/intake_verifications_live/);
  });

  it('refuses a code minted for another purpose', async () => {
    const id = await insert(TENANT_A, LOCAL_FIXTURE.ventureA, LOCAL_FIXTURE.intakeChannelA);
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `INSERT INTO oe.intake_verifications
             (tenant_id, id, request_id, code_hash, audience, expires_at, delivery)
           VALUES ($1, $2, $3, $4, 'report_access', now(), 'recorded_local_only')`,
          [TENANT_A, uuid(), id, Buffer.alloc(32, 2)],
        ),
      ),
    ).rejects.toThrow(/intake_verifications_audience_check/);
  });
});

describe('rate-limit counters', () => {
  const key = `contact:${'a'.repeat(64)}`;
  const window = '2026-09-21T14:00:00Z';

  it('counts across the tenant boundary, because the abuse does', async () => {
    // One attacker submitting to twenty channels is one attacker. A per-tenant counter would
    // hand them twenty budgets.
    const first = await db.withoutTenant((tx) =>
      countRateLimitHit(tx, { scopeKey: key, windowStart: window }),
    );
    const second = await db.withTenant(LOCAL_FIXTURE.tenantB, (tx) =>
      countRateLimitHit(tx, { scopeKey: key, windowStart: window }),
    );
    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it('keeps separate windows separate', async () => {
    const other = await db.withoutTenant((tx) =>
      countRateLimitHit(tx, { scopeKey: key, windowStart: '2026-09-21T15:00:00Z' }),
    );
    expect(other).toBe(1);
  });

  it('refuses a key that is not an opaque hash', async () => {
    // The table sits outside the tenant boundary, so what it is keyed by has to be
    // meaningless. A readable key here would be a personal-data leak with no owner.
    await expect(
      db.withoutTenant((tx) =>
        countRateLimitHit(tx, { scopeKey: 'contact:person@example.com', windowStart: window }),
      ),
    ).rejects.toThrow(/rate_limits_scope_key_check/);
  });

  it('does not let the runtime role read or clear another key', async () => {
    // It counts through a SECURITY DEFINER function and holds nothing on the table itself,
    // so it cannot learn another key's total or wipe its own.
    await expect(
      db.withoutTenant((tx) => tx.query('SELECT hits FROM oe_public.rate_limits')),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.withoutTenant((tx) => tx.query('DELETE FROM oe_public.rate_limits')),
    ).rejects.toThrow(/permission denied/);
  });

  it('sweeps windows older than the cutoff and leaves newer ones', async () => {
    const removed = await db.withoutTenant((tx) => sweepRateLimits(tx, '2026-09-21T14:30:00Z'));
    expect(removed).toBeGreaterThanOrEqual(1);
    const stillThere = await db.withoutTenant((tx) =>
      countRateLimitHit(tx, { scopeKey: key, windowStart: '2026-09-21T15:00:00Z' }),
    );
    expect(stillThere).toBe(2);
  });
});
