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
import pg from 'pg';
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
 * The fixture site's own host. The production URL policy denies `.test` and loopback, which
 * is why the fixture transport is a separate test-only adapter rather than a relaxed policy.
 */
const FIXTURE_HOST = '127.0.0.1:4179';

export async function seedLocal(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await seedTenant(client, {
      tenantId: LOCAL_FIXTURE.tenantA,
      name: 'IntelligentLab (local fixture)',
      ventureId: LOCAL_FIXTURE.ventureA,
      ventureSlug: 'marktfix',
      accountId: LOCAL_FIXTURE.accountA,
      accountName: 'Atelier Nord (synthetic fixture)',
      domain: 'atelier-nord.test',
      authorizationId: LOCAL_FIXTURE.authorizationA,
      tenantBudgetId: LOCAL_FIXTURE.tenantBudgetA,
      ventureBudgetId: LOCAL_FIXTURE.ventureBudgetA,
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
      ventureSlug: 'pdp-studio',
      accountId: LOCAL_FIXTURE.accountB,
      accountName: 'Modewerk Studio (synthetic fixture)',
      domain: 'modewerk.test',
      authorizationId: LOCAL_FIXTURE.authorizationB,
      tenantBudgetId: LOCAL_FIXTURE.tenantBudgetB,
      ventureBudgetId: LOCAL_FIXTURE.ventureBudgetB,
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
  accountId: string;
  accountName: string;
  domain: string;
  authorizationId: string;
  tenantBudgetId: string;
  ventureBudgetId: string;
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
  await client.query(
    `INSERT INTO oe.ventures (tenant_id, id, slug, name, enabled)
     VALUES ($1, $2, $3, $4, true) ON CONFLICT (tenant_id, id) DO NOTHING`,
    [seed.tenantId, seed.ventureId, seed.ventureSlug, seed.ventureSlug],
  );

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

  await client.query(
    `INSERT INTO oe.accounts
       (tenant_id, id, venture_id, name, canonical_domain, approved_hosts, source_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      seed.tenantId,
      seed.accountId,
      seed.ventureId,
      seed.accountName,
      seed.domain,
      [seed.domain, FIXTURE_HOST],
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
