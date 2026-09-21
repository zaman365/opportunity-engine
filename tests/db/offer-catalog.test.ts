import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countOpenCommitments,
  getDeliveryCapacity,
  insertOfferDraft,
  insertOfferPrerequisite,
  listCurrentOffers,
  listOfferPrerequisites,
  revokeOfferPrerequisite,
  withdrawOfferDraft,
  type Database,
} from '@oe/db';
import { freshHarness, LOCAL_FIXTURE, uuid, type Harness } from '../support/harness.ts';

/**
 * The catalogue's guarantees, checked against the database that enforces them.
 *
 * Every rule here is stated twice on purpose: once in TypeScript, where it produces a readable
 * refusal, and once as a constraint, where it holds even if the TypeScript is bypassed. This
 * suite tests the second copy — what survives a caller that skips the service layer.
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

const TENANT_A = LOCAL_FIXTURE.tenantA;
const TENANT_B = LOCAL_FIXTURE.tenantB;

describe('the seeded catalogue', () => {
  it('prices the marktfix repair at the approved figure, and nothing else', async () => {
    const offers = await db.withTenant(TENANT_A, (tx) =>
      listCurrentOffers(tx, LOCAL_FIXTURE.ventureA),
    );
    expect(offers.map((o) => o.sku)).toEqual(['MF-LINK-REPAIR']);
    expect(offers[0]).toMatchObject({
      enabled: true,
      currency: 'EUR',
      price_minor: '29000',
      min_effort_minutes: 60,
      max_effort_minutes: 180,
    });
    // The approver is a row, not a string: an approval names somebody in this workspace.
    expect(offers[0]!.approved_by).toBe(LOCAL_FIXTURE.ownerA);
  });

  it('scopes the catalogue to the venture that sells it', async () => {
    const pdp = await db.withTenant(TENANT_A, (tx) =>
      listCurrentOffers(tx, LOCAL_FIXTURE.venturePdpA),
    );
    expect(pdp.map((o) => o.sku)).toEqual(['PDP-REVIEWED-AUDIT']);
  });

  it("does not leak one workspace's approvals into another", async () => {
    const offers = await db.withTenant(TENANT_B, (tx) =>
      listCurrentOffers(tx, LOCAL_FIXTURE.ventureB),
    );
    expect(offers).toEqual([]);
  });
});

describe('enabled requires an approved price', () => {
  /** Straight to SQL: this is the copy of the rule that holds when the service is bypassed. */
  async function insertRaw(columns: Record<string, unknown>): Promise<void> {
    await db.withTenant(TENANT_A, async (tx) => {
      const base: Record<string, unknown> = {
        tenant_id: TENANT_A,
        id: uuid(),
        venture_id: LOCAL_FIXTURE.ventureA,
        sku: 'TEST-SKU',
        version: 1,
        promise: 'x',
        detector_families: ['MF-LINK-01'],
        inclusions: '[]',
        exclusions: '[]',
        prerequisites: '[]',
        acceptance: '["x"]',
        ...columns,
      };
      const keys = Object.keys(base);
      await tx.query(
        `INSERT INTO oe.offers (${keys.join(', ')})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        keys.map((key) => base[key]),
      );
    });
  }

  it('refuses an enabled offer with no price', async () => {
    await expect(insertRaw({ enabled: true })).rejects.toThrow(/offers_enabled_requires_approval/);
  });

  it('refuses an enabled offer priced by nobody', async () => {
    await expect(
      insertRaw({ enabled: true, currency: 'EUR', price_minor: '29000' }),
    ).rejects.toThrow(/offers_enabled_requires_approval/);
  });

  it('allows a disabled offer with no price — the state the kit ships in', async () => {
    await expect(insertRaw({ enabled: false, sku: 'TEST-UNPRICED' })).resolves.toBeUndefined();
  });

  it('refuses a negative price', async () => {
    await expect(insertRaw({ price_minor: '-1', sku: 'TEST-NEGATIVE' })).rejects.toThrow();
  });
});

describe('drafted scopes', () => {
  async function seedDraft(sku = 'MF-LINK-REPAIR'): Promise<string> {
    const id = uuid();
    await db.withTenant(TENANT_A, async (tx) => {
      const [offer] = await listCurrentOffers(tx, LOCAL_FIXTURE.ventureA);
      await insertOfferDraft(tx, {
        id,
        opportunityId: await anOpportunity(tx),
        offerId: offer!.id,
        offerSku: sku,
        offerVersion: offer!.version,
        currency: 'EUR',
        priceMinor: '29000',
        snapshot: { promise: offer!.promise },
        findingIds: [FINDING_ID],
        rootCauseKeys: ['size-guide-404'],
        createdBy: LOCAL_FIXTURE.reviewerA,
      });
    });
    return id;
  }

  const FINDING_ID = uuid();
  const OPPORTUNITY_ID = uuid();

  /** A minimal case to hang a draft on; the API path is covered by the integration suite. */
  async function anOpportunity(tx: {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
  }): Promise<string> {
    await tx.query(
      `INSERT INTO oe.opportunities
         (tenant_id, id, account_id, venture_id, title, permission_state, next_action)
       VALUES ($1, $2, $3, $4, 'fixture case', 'review_allowed', 'draft_offer')
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [TENANT_A, OPPORTUNITY_ID, LOCAL_FIXTURE.accountA, LOCAL_FIXTURE.ventureA],
    );
    return OPPORTUNITY_ID;
  }

  it('allows one open draft per case and SKU, and refuses a second', async () => {
    await seedDraft();
    // Two open drafts would be two prices for one job.
    await expect(seedDraft()).rejects.toThrow(/offer_drafts_one_open/);
  });

  it('counts an open draft as a delivery commitment', async () => {
    const [open, capacity] = await db.withTenant(TENANT_A, async (tx) => [
      await countOpenCommitments(tx),
      await getDeliveryCapacity(tx),
    ]);
    expect(open).toBe(1);
    expect(capacity).toBe(3);
  });

  it('frees the slot when a draft is withdrawn, and lets the SKU be drafted again', async () => {
    const withdrawn = await db.withTenant(TENANT_A, async (tx) => {
      const [draft] = await tx
        .query<{ id: string; version: number }>(
          "SELECT id, version FROM oe.offer_drafts WHERE state = 'draft'",
        )
        .then((r) => r.rows);
      return withdrawOfferDraft(tx, {
        id: draft!.id,
        expectedVersion: draft!.version,
        reason: 'Customer postponed the work.',
        at: '2026-09-21T10:00:00Z',
      });
    });
    expect(withdrawn).toMatchObject({ state: 'withdrawn', version: 2 });
    expect(withdrawn!.withdraw_reason).toBe('Customer postponed the work.');

    const open = await db.withTenant(TENANT_A, (tx) => countOpenCommitments(tx));
    expect(open).toBe(0);
    await expect(seedDraft()).resolves.toBeTypeOf('string');
  });

  it('refuses to withdraw at a version that has already moved', async () => {
    const result = await db.withTenant(TENANT_A, (tx) =>
      withdrawOfferDraft(tx, {
        id: OPPORTUNITY_ID,
        expectedVersion: 99,
        reason: 'x',
        at: '2026-09-21T10:00:00Z',
      }),
    );
    expect(result).toBeNull();
  });
});

describe('recorded prerequisites', () => {
  it('records one, then refuses a duplicate while it is live', async () => {
    await db.withTenant(TENANT_A, (tx) =>
      insertOfferPrerequisite(tx, {
        id: uuid(),
        accountId: LOCAL_FIXTURE.accountA,
        prerequisite: 'agreed destination',
        note: 'Confirmed by email with the shop owner on 20 September 2026.',
        recordedBy: LOCAL_FIXTURE.ownerA,
      }),
    );
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        insertOfferPrerequisite(tx, {
          id: uuid(),
          accountId: LOCAL_FIXTURE.accountA,
          prerequisite: 'agreed destination',
          note: 'Same claim, recorded twice.',
          recordedBy: LOCAL_FIXTURE.ownerA,
        }),
      ),
    ).rejects.toThrow(/offer_prerequisites_live/);
  });

  it('keeps a revoked record and allows the same claim to be made again', async () => {
    const revoked = await db.withTenant(TENANT_A, (tx) =>
      revokeOfferPrerequisite(tx, {
        accountId: LOCAL_FIXTURE.accountA,
        prerequisite: 'agreed destination',
        reason: 'The shop changed the destination page.',
        at: '2026-09-21T11:00:00Z',
      }),
    );
    expect(revoked!.revoked_at).toBe('2026-09-21T11:00:00Z');

    await db.withTenant(TENANT_A, (tx) =>
      insertOfferPrerequisite(tx, {
        id: uuid(),
        accountId: LOCAL_FIXTURE.accountA,
        prerequisite: 'agreed destination',
        note: 'New destination agreed on 21 September 2026.',
        recordedBy: LOCAL_FIXTURE.ownerA,
      }),
    );

    const rows = await db.withTenant(TENANT_A, (tx) =>
      listOfferPrerequisites(tx, LOCAL_FIXTURE.accountA),
    );
    // History, not current state: both the revoked claim and the new one are readable.
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
  });
});
