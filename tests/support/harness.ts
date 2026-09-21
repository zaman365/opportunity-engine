import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, dropAll, loadDotEnv, migrate } from '@oe/db';
import { LocalFsEvidenceStore } from '@oe/evidence';
import { loadConfig, type AppConfig } from '@oe/domain';
import { LOCAL_FIXTURE, seedLocal } from '../../scripts/seed-local.ts';

/**
 * Shared harness for the database and integration suites.
 *
 * These tests require the disposable cluster from `npm run db:up`. They do not skip when it
 * is absent: TEST_PLAN.md says cloud tests are "explicitly skipped/blocked when resources
 * are absent, never mocked into passing", and a local PostgreSQL is not a cloud resource —
 * it is a prerequisite the developer can satisfy, so a missing one is a failure.
 */

loadDotEnv();

export function requireDatabaseUrls(): { runtime: string; migration: string; identity: string } {
  const runtime = process.env.DATABASE_URL;
  const migration = process.env.MIGRATION_DATABASE_URL;
  if (!runtime || !migration) {
    throw new Error(
      'DATABASE_URL and MIGRATION_DATABASE_URL are required for this suite. Run `npm run db:up` first.',
    );
  }
  return { runtime, migration, identity: process.env.IDENTITY_DATABASE_URL ?? runtime };
}

export interface Harness {
  db: Database;
  identityDb: Database;
  evidence: LocalFsEvidenceStore;
  evidenceDir: string;
  config: AppConfig;
  close(): Promise<void>;
}

/** Rebuild the schema from empty and reseed, so every suite starts from a known state. */
export async function freshHarness(): Promise<Harness> {
  const urls = requireDatabaseUrls();
  await dropAll(urls.migration);
  await migrate({
    migrationUrl: urls.migration,
    runtimeRole: process.env.OE_RUNTIME_ROLE ?? 'oe_runtime',
    identityRole: process.env.OE_IDENTITY_ROLE ?? 'oe_identity',
  });
  await seedLocal(urls.migration);

  const evidenceDir = mkdtempSync(join(tmpdir(), 'oe-evidence-'));
  const config = loadConfig({
    APP_ENV: 'local',
    APP_ORIGIN: 'http://127.0.0.1:4173',
    AUTH_MODE: 'fixture_local_only',
    DATABASE_URL: urls.runtime,
    MIGRATION_DATABASE_URL: urls.migration,
    LEDGER_CURRENCY: 'USD',
    LIVE_SPEND_LIMIT_MICRO: '0',
    CAPTURE_ADAPTER: 'local_fixture',
    FIXTURE_ORIGIN: process.env.FIXTURE_ORIGIN ?? 'http://127.0.0.1:4179,http://127.0.0.1:4180',
    EVIDENCE_STORE: 'local_fs',
    EVIDENCE_LOCAL_DIR: evidenceDir,
    // The M3 public surface, with the channel that sends nothing. `loadConfig` refuses this
    // combination outside APP_ENV=local, which is what makes turning it on here acceptable.
    PUBLIC_INTAKE_ENABLED: 'true',
    INTAKE_VERIFICATION_CHANNEL: 'recorded_local_only',
    INTAKE_SECRET: 'local-test-intake-secret-000000000000',
  });

  const db = new Database({ connectionString: urls.runtime, applicationName: 'oe-test-runtime' });
  const identityDb = new Database({
    connectionString: urls.identity,
    applicationName: 'oe-test-identity',
    max: 4,
  });

  return {
    db,
    identityDb,
    evidence: new LocalFsEvidenceStore(evidenceDir),
    evidenceDir,
    config,
    async close() {
      await db.close();
      await identityDb.close();
      rmSync(evidenceDir, { recursive: true, force: true });
    },
  };
}

export { LOCAL_FIXTURE };

/** Deterministic identifiers make an admission assertion readable. */
export function sequentialIds(prefix = 'aaaaaaaa'): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
  };
}

export const uuid = () => randomUUID();
