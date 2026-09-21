/**
 * Local fixture seed.
 *
 * Creates two isolated `.test` tenants so cross-tenant behaviour can be exercised, plus the
 * ventures, memberships, accounts, authorizations and cost limits a local operator needs.
 *
 * Runs as the migration role, because bootstrapping membership is an owner procedure rather
 * than a runtime capability (ROLES_PERMISSIONS.md). It refuses outside APP_ENV=local, and
 * ENVIRONMENT_AND_COMMANDS.md keeps production free of default admins and seeded findings:
 * nothing here is reachable from a deployed build.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { mergeOfferCatalog, type MergedOffer } from '../packages/domain/src/offer-catalog.ts';
import { loadDotEnv } from '../packages/db/src/dotenv.ts';

loadDotEnv();

if (process.env.APP_ENV !== 'local') {
  process.stderr.write('seed-local refuses to run outside APP_ENV=local.\n');
  process.exit(1);
}
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationUrl) {
  process.stderr.write('MIGRATION_DATABASE_URL is required. Run `npm run db:up` first.\n');
  process.exit(1);
}

/** Stable identifiers so tests and the operator UI can refer to the same fixture rows. */
export const LOCAL_FIXTURE = {
  tenantA: '11111111-1111-4111-8111-111111111111',
  tenantB: '22222222-2222-4222-8222-222222222222',
  ventureA: '11111111-1111-4111-8111-000000000001',
  venturePdpA: '11111111-1111-4111-8111-000000000002',
  ventureB: '22222222-2222-4222-8222-000000000001',
  accountA: '11111111-1111-4111-8111-000000000010',
  accountB: '22222222-2222-4222-8222-000000000010',
  authorizationA: '11111111-1111-4111-8111-000000000020',
  authorizationB: '22222222-2222-4222-8222-000000000020',
  ownerA: '11111111-1111-4111-8111-000000000100',
  operatorA: '11111111-1111-4111-8111-000000000101',
  reviewerA: '11111111-1111-4111-8111-000000000102',
  viewerA: '11111111-1111-4111-8111-000000000103',
  ownerB: '22222222-2222-4222-8222-000000000100',
  tenantBudgetA: '11111111-1111-4111-8111-000000000200',
  ventureBudgetA: '11111111-1111-4111-8111-000000000201',
  tenantBudgetB: '22222222-2222-4222-8222-000000000200',
  ventureBudgetB: '22222222-2222-4222-8222-000000000201',
  issuer: 'urn:opportunity-engine:local-fixture',
} as const;

/**
 * The catalogue as the owner approved it: the kit's scope definition, plus the price file.
 *
 * Read once, merged once, and refused as a whole if any entry is malformed. A partially
 * seeded catalogue is worse than none — it would leave a SKU sellable at a price nobody
 * checked.
 */
function loadApprovedCatalog(): MergedOffer[] {
  const read = (relative: string): unknown =>
    JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));
  const { offers, problems } = mergeOfferCatalog(
    read('../opportunity-engine-build-kit/config/offer-catalog.json'),
    read('../config/offer-approvals.json'),
  );
  if (problems.length > 0) {
    throw new Error(`Offer catalogue rejected:\n- ${problems.join('\n- ')}`);
  }
  return offers;
}

/**
 * The fixture sites' own hosts: the kit's MF-LINK-01 site and this repository's MF-ASSET-01
 * site. The production URL policy denies `.test` and loopback, which is why the fixture
 * transport is a separate test-only adapter rather than a relaxed policy.
 *
 * Re-seeding converges the account's allowlist onto this list, so adding a fixture site does
 * not require rebuilding the local database.
 */
const FIXTURE_HOSTS = ['127.0.0.1:4179', '127.0.0.1:4180'];

export async function seedLocal(connectionString: string): Promise<void> {
  const catalog = loadApprovedCatalog();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await seedTenant(client, {
      tenantId: LOCAL_FIXTURE.tenantA,
      name: 'IntelligentLab (local fixture)',
      ventureId: LOCAL_FIXTURE.ventureA,
      ventureSlug: 'marktfix',
      // The same workspace, a second brand. Both are IntelligentLab's, which is why the
      // catalogue splits across them and membership is assigned per venture.
      secondaryVentures: [{ id: LOCAL_FIXTURE.venturePdpA, slug: 'pdp-studio' }],
      accountId: LOCAL_FIXTURE.accountA,
      accountName: 'Atelier Nord (synthetic fixture)',
      domain: 'atelier-nord.test',
      authorizationId: LOCAL_FIXTURE.authorizationA,
      tenantBudgetId: LOCAL_FIXTURE.tenantBudgetA,
      ventureBudgetId: LOCAL_FIXTURE.ventureBudgetA,
      catalog,
      members: [
        { id: LOCAL_FIXTURE.ownerA, subject: 'owner@fixture.test', role: 'owner' },
        { id: LOCAL_FIXTURE.operatorA, subject: 'operator@fixture.test', role: 'operator' },
        { id: LOCAL_FIXTURE.reviewerA, subject: 'reviewer@fixture.test', role: 'reviewer' },
        { id: LOCAL_FIXTURE.viewerA, subject: 'viewer@fixture.test', role: 'viewer' },
      ],
    });
    await seedTenant(client, {
      tenantId: LOCAL_FIXTURE.tenantB,
      name: 'Second workspace (isolation fixture)',
      ventureId: LOCAL_FIXTURE.ventureB,
      // An unrelated workspace, not a second IntelligentLab brand. Its catalogue is empty,
      // which is the assertion: approvals recorded in one workspace do not leak into another.
      ventureSlug: 'modewerk',
      secondaryVentures: [],
      accountId: LOCAL_FIXTURE.accountB,
      accountName: 'Modewerk Studio (synthetic fixture)',
      domain: 'modewerk.test',
      authorizationId: LOCAL_FIXTURE.authorizationB,
      tenantBudgetId: LOCAL_FIXTURE.tenantBudgetB,
      ventureBudgetId: LOCAL_FIXTURE.ventureBudgetB,
      catalog,
      members: [{ id: LOCAL_FIXTURE.ownerB, subject: 'other-owner@fixture.test', role: 'owner' }],
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

interface TenantSeed {
  tenantId: string;
  name: string;
  ventureId: string;
  ventureSlug: string;
  secondaryVentures: { id: string; slug: string }[];
  accountId: string;
  accountName: string;
  domain: string;
  authorizationId: string;
  tenantBudgetId: string;
  ventureBudgetId: string;
  catalog: MergedOffer[];
  members: { id: string; subject: string; role: 'owner' | 'operator' | 'reviewer' | 'viewer' }[];
}

async function seedTenant(client: pg.Client, seed: TenantSeed): Promise<void> {
  // FORCE RLS applies to the schema owner too, so even the seed runs inside a tenant context.
  await client.query('SELECT set_config($1, $2, true)', ['oe.tenant_id', seed.tenantId]);

  await client.query(
    `INSERT INTO oe.tenants (id, name, legal_controller, ledger_currency)
     VALUES ($1, $2, $3, 'USD') ON CONFLICT (id) DO NOTHING`,
    [seed.tenantId, seed.name, 'owner_must_verify'],
  );
  for (const venture of [
    { id: seed.ventureId, slug: seed.ventureSlug },
    ...seed.secondaryVentures,
  ]) {
    await client.query(
      `INSERT INTO oe.ventures (tenant_id, id, slug, name, enabled)
       VALUES ($1, $2, $3, $4, true) ON CONFLICT (tenant_id, id) DO NOTHING`,
      [seed.tenantId, venture.id, venture.slug, venture.slug],
    );
  }

  for (const member of seed.members) {
    await client.query(
      `INSERT INTO oe.memberships (tenant_id, id, issuer, subject, role, active)
       VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT (tenant_id, id) DO NOTHING`,
      [seed.tenantId, member.id, LOCAL_FIXTURE.issuer, member.subject, member.role],
    );
    await client.query(
      `INSERT INTO oe.member_ventures (tenant_id, id, membership_id, venture_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, membership_id, venture_id) DO NOTHING`,
      [seed.tenantId, deriveId(member.id, 'mv'), member.id, seed.ventureId],
    );
  }

  // The owner is the only member of the secondary ventures. ACCESS_MODEL.md: assign people
  // per venture rather than giving everyone everything.
  const owner = seed.members.find((member) => member.role === 'owner');
  if (!owner) throw new Error(`Tenant ${seed.tenantId} has no owner.`);
  for (const venture of seed.secondaryVentures) {
    await client.query(
      `INSERT INTO oe.member_ventures (tenant_id, id, membership_id, venture_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, membership_id, venture_id) DO NOTHING`,
      [seed.tenantId, deriveId(venture.id, 'mv'), owner.id, venture.id],
    );
  }

  await client.query(
    `INSERT INTO oe.accounts
       (tenant_id, id, venture_id, name, canonical_domain, approved_hosts, source_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, id) DO UPDATE
       SET approved_hosts = EXCLUDED.approved_hosts, name = EXCLUDED.name`,
    [
      seed.tenantId,
      seed.accountId,
      seed.ventureId,
      seed.accountName,
      seed.domain,
      [seed.domain, ...FIXTURE_HOSTS],
      'Synthetic local fixture. Not a real merchant and not a record of any permission.',
    ],
  );

  await client.query(
    `INSERT INTO oe.authorizations
       (tenant_id, id, account_id, action, purpose, evidence_note, policy_version, granted_by, expires_at)
     VALUES ($1, $2, $3, 'scan_public', $4, $5, 'local-fixture-policy-v1', $6, now() + interval '90 days')
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      seed.tenantId,
      seed.authorizationId,
      seed.accountId,
      'Local fixture inspection of a synthetic product page.',
      'Synthetic fixture only. No real permission from any business is represented here.',
      seed.members[0]!.id,
    ],
  );

  // Cost limits start unpaused with a nonzero ceiling so the local journey exercises the
  // reservation path. The fixture transport still reports zero actual cost.
  for (const [id, kind, scopeId] of [
    [seed.tenantBudgetId, 'tenant', seed.tenantId],
    [seed.ventureBudgetId, 'venture', seed.ventureId],
  ] as const) {
    await client.query(
      `INSERT INTO oe.budgets (tenant_id, id, scope_kind, scope_id, currency, limit_micro, paused)
       VALUES ($1, $2, $3, $4, 'USD', 5000000, false)
       ON CONFLICT (tenant_id, scope_kind, scope_id) DO NOTHING`,
      [seed.tenantId, id, kind, scopeId],
    );
  }

  await seedOffers(client, seed);
}

/**
 * Seed the venture's catalogue, and the delivery capacity that bounds how much of it can be
 * committed at once.
 *
 * A catalogue entry is written once per (tenant, sku, version) and never updated in place:
 * `ON CONFLICT DO NOTHING` here is the same rule migration 0009 states — "catalog change
 * requires owner and new version" — so re-seeding after an approval changes nothing until the
 * version moves. That is deliberate. Silently repricing a SKU under a quote already given is
 * exactly what the immutability rule exists to prevent.
 */
async function seedOffers(client: pg.Client, seed: TenantSeed): Promise<void> {
  const owner = seed.members.find((member) => member.role === 'owner');
  if (!owner) throw new Error(`Tenant ${seed.tenantId} has no owner to attribute approvals to.`);

  // A SKU belongs to the venture that sells it. One this workspace has no venture for is not
  // an error — it belongs to somebody else's catalogue.
  const ventureIds = new Map(
    [{ id: seed.ventureId, slug: seed.ventureSlug }, ...seed.secondaryVentures].map((venture) => [
      venture.slug,
      venture.id,
    ]),
  );

  for (const offer of seed.catalog) {
    const ventureId = ventureIds.get(offer.venture);
    if (ventureId === undefined) continue;
    // The approval names a person, not a row id. Resolving it here means an approval file
    // that names somebody who is not a member of this workspace fails loudly.
    let approvedBy: string | null = null;
    if (offer.approvedBySubject !== null) {
      const member = seed.members.find(
        (candidate) => candidate.subject === offer.approvedBySubject,
      );
      if (!member) {
        throw new Error(
          `${offer.sku}@${offer.version} is approved by ${offer.approvedBySubject}, who is not a member of this workspace.`,
        );
      }
      if (member.role !== 'owner') {
        throw new Error(
          `${offer.sku}@${offer.version} is approved by ${offer.approvedBySubject}, whose role is ${member.role}. Pricing is an owner decision.`,
        );
      }
      approvedBy = member.id;
    }

    await client.query(
      `INSERT INTO oe.offers
         (tenant_id, id, venture_id, sku, version, promise, detector_families, inclusions,
          exclusions, prerequisites, acceptance, currency, price_minor, tax_treatment,
          min_effort_minutes, max_effort_minutes, enabled, approved_by, approved_at, approval_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
               $12, $13::bigint, $14, $15, $16, $17, $18, $19::timestamptz, $20)
       ON CONFLICT (tenant_id, sku, version) DO NOTHING`,
      [
        seed.tenantId,
        deriveOfferId(seed.tenantId, offer.sku, offer.version),
        ventureId,
        offer.sku,
        offer.version,
        offer.promise,
        offer.detectorFamilies,
        JSON.stringify(offer.inclusions),
        JSON.stringify(offer.exclusions),
        JSON.stringify(offer.prerequisites),
        JSON.stringify(offer.acceptance),
        offer.currency,
        offer.priceMinor,
        offer.taxTreatment,
        offer.minEffortMinutes,
        offer.maxEffortMinutes,
        offer.enabled,
        approvedBy,
        offer.approvedAt,
        offer.approvalNote,
      ],
    );
  }

  // Three concurrent commitments. BUILD_SPEC.md §18 wants delivery treated as a budget like
  // any other; with one reviewer the real ceiling is attention, not compute, and a number
  // that binds is more useful than one that never does.
  await client.query(
    `INSERT INTO oe.delivery_capacity (tenant_id, concurrent_limit, updated_by)
     VALUES ($1, 3, $2) ON CONFLICT (tenant_id) DO NOTHING`,
    [seed.tenantId, owner.id],
  );
}

/**
 * A stable UUID for a catalogue entry, derived from tenant, SKU and version.
 *
 * RFC 9562 version 5: same inputs, same id, on every machine that seeds. Re-seeding must not
 * mint a second row for a SKU that already exists, and tests need to name one without
 * querying for it first.
 */
function deriveOfferId(tenantId: string, sku: string, version: number): string {
  const namespace = Buffer.from(tenantId.replaceAll('-', ''), 'hex');
  const digest = createHash('sha1').update(namespace).update(`offer:${sku}:${version}`).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50; // version 5
  digest[8] = (digest[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Derive a stable secondary UUID from a member UUID so reruns do not create duplicates. */
function deriveId(base: string, tag: string): string {
  const suffix = tag === 'mv' ? 'a' : 'b';
  return `${base.slice(0, 34)}${suffix}${base.slice(35)}`;
}

const invokedDirectly = process.argv[1]?.endsWith('seed-local.ts');
if (invokedDirectly) {
  await seedLocal(migrationUrl);
  process.stdout.write(
    'Seeded two synthetic local tenants. Sign in with the x-fixture-subject header, e.g. operator@fixture.test.\n',
  );
}
