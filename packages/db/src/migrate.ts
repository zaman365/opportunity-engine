/**
 * Migration runner.
 *
 * Applies `packages/db/migrations/*.sql` in filename order, once each, recording a checksum
 * in `oe_meta.schema_migrations`. A file that changed after it was applied is an error, not
 * a silent re-run.
 *
 * Runs as the migration role only. It sets `oe.runtime_role` / `oe.identity_role` as
 * transaction-local settings so the grant migrations contain no hardcoded role names.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

export interface MigrationOptions {
  migrationUrl: string;
  runtimeRole: string;
  identityRole: string;
  /** Print each applied version. Off inside tests. */
  log?: (message: string) => void;
}

export interface AppliedMigration {
  version: string;
  applied: boolean;
}

function listMigrations(): { version: string; sql: string; checksum: string }[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(resolve(migrationsDir, name), 'utf8');
      return {
        version: name.replace(/\.sql$/, ''),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

export async function migrate(options: MigrationOptions): Promise<AppliedMigration[]> {
  const log = options.log ?? (() => undefined);
  const client = new pg.Client({ connectionString: options.migrationUrl });
  await client.connect();
  const results: AppliedMigration[] = [];
  try {
    const migrations = listMigrations();
    const bootstrap = migrations[0];
    if (!bootstrap || bootstrap.version !== '0000_migration_history') {
      throw new Error('0000_migration_history must be the first migration.');
    }

    for (const migration of migrations) {
      // The history table itself cannot be guarded by the history table.
      if (migration.version !== '0000_migration_history') {
        const existing = await client.query<{ checksum: string }>(
          'SELECT checksum FROM oe_meta.schema_migrations WHERE version = $1',
          [migration.version],
        );
        const previous = existing.rows[0];
        if (previous) {
          if (previous.checksum !== migration.checksum) {
            throw new Error(
              `Migration ${migration.version} changed after it was applied. ` +
                'Add a new migration instead of editing an applied one.',
            );
          }
          results.push({ version: migration.version, applied: false });
          continue;
        }
      }

      await client.query('BEGIN');
      try {
        await client.query('SELECT set_config($1, $2, true)', ['oe.runtime_role', options.runtimeRole]);
        await client.query('SELECT set_config($1, $2, true)', ['oe.identity_role', options.identityRole]);
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO oe_meta.schema_migrations (version, checksum) VALUES ($1, $2)
           ON CONFLICT (version) DO NOTHING`,
          [migration.version, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(
          `Migration ${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      log(`applied ${migration.version}`);
      results.push({ version: migration.version, applied: true });
    }
    return results;
  } finally {
    await client.end();
  }
}

/** Drop the schemas this runner owns. Test-harness support; never used against a deployment. */
export async function dropAll(migrationUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS oe CASCADE');
    await client.query('DROP SCHEMA IF EXISTS oe_dispatch CASCADE');
    await client.query('DROP SCHEMA IF EXISTS oe_meta CASCADE');
  } finally {
    await client.end();
  }
}

export function migrationVersions(): string[] {
  return listMigrations().map((m) => m.version);
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').at(-1)!);
if (isDirectRun) {
  const { loadDotEnv } = await import('./dotenv.ts');
  loadDotEnv();
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  if (!migrationUrl) {
    process.stderr.write('MIGRATION_DATABASE_URL is required. Run `npm run db:up` first.\n');
    process.exit(1);
  }
  const applied = await migrate({
    migrationUrl,
    runtimeRole: process.env.OE_RUNTIME_ROLE ?? 'oe_runtime',
    identityRole: process.env.OE_IDENTITY_ROLE ?? 'oe_identity',
    log: (message) => process.stdout.write(`${message}\n`),
  });
  const changed = applied.filter((a) => a.applied).length;
  process.stdout.write(`${changed} migration(s) applied, ${applied.length - changed} already present.\n`);
}
