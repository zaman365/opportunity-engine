#!/usr/bin/env node
/**
 * Disposable local PostgreSQL for development and the database test suite.
 *
 * Creates its own cluster under `.local-postgres/`, on a non-default port, with its own
 * superuser. It never touches an existing cluster, an existing database or port 5432.
 * `down` stops the cluster; `--purge` also deletes the data directory.
 *
 * Roles created here mirror DATA_MODEL.md:
 *   oe_migrate  owns the schema, runs migrations
 *   oe_runtime  application requests: NOSUPERUSER, NOBYPASSRLS, non-owner
 *   oe_identity membership lookup before a tenant context exists
 *
 * Passwords are generated per cluster into `.local-postgres/credentials.json`, which is
 * gitignored. Nothing here is a production provisioning script.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, '.local-postgres/data');
const socketDir = resolve(root, '.local-postgres/run');
const logFile = resolve(root, '.local-postgres/server.log');
const credentialsFile = resolve(root, '.local-postgres/credentials.json');
const envFile = resolve(root, '.env.local');
const PORT = Number(process.env.OE_DEV_PG_PORT ?? 55432);
const DB = 'opportunity_engine_dev';
const SUPERUSER = 'oe_dev_super';

// macOS: the postmaster refuses to start if it becomes multithreaded during startup,
// which happens unless a concrete locale is set. C keeps collation deterministic anyway.
const BASE_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: BASE_ENV, ...options });
  if (result.error) throw result.error;
  return result;
}

function must(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function psqlArgs(database, user) {
  return ['-h', socketDir, '-p', String(PORT), '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1'];
}

function isRunning() {
  return run('pg_ctl', ['-D', dataDir, 'status']).status === 0;
}

function credentials() {
  if (!existsSync(credentialsFile))
    throw new Error('Cluster credentials missing; run `npm run db:up`.');
  return JSON.parse(readFileSync(credentialsFile, 'utf8'));
}

function up() {
  mkdirSync(socketDir, { recursive: true });
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    const passwordFile = resolve(root, '.local-postgres/.initpw');
    const superPassword = randomBytes(24).toString('base64url');
    writeFileSync(passwordFile, superPassword, { mode: 0o600 });
    must('initdb', [
      '-D',
      dataDir,
      '-U',
      SUPERUSER,
      '--auth-local=scram-sha-256',
      '--auth-host=scram-sha-256',
      `--pwfile=${passwordFile}`,
      '--encoding=UTF8',
      '--locale=C',
    ]);
    rmSync(passwordFile, { force: true });
    writeFileSync(
      credentialsFile,
      JSON.stringify(
        {
          port: PORT,
          socketDir,
          database: DB,
          superuser: { user: SUPERUSER, password: superPassword },
          migrate: { user: 'oe_migrate', password: randomBytes(24).toString('base64url') },
          runtime: { user: 'oe_runtime', password: randomBytes(24).toString('base64url') },
          identity: { user: 'oe_identity', password: randomBytes(24).toString('base64url') },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }

  if (!isRunning()) {
    must('pg_ctl', [
      '-D',
      dataDir,
      '-l',
      logFile,
      '-o',
      `-p ${PORT} -k ${socketDir} -c listen_addresses=''`,
      '-w',
      'start',
    ]);
  }

  const creds = credentials();
  const superEnv = { ...BASE_ENV, PGPASSWORD: creds.superuser.password };

  const exists = must(
    'psql',
    [
      ...psqlArgs('postgres', SUPERUSER),
      '-tAc',
      `SELECT 1 FROM pg_database WHERE datname = '${DB}'`,
    ],
    { env: superEnv },
  );
  if (!exists.stdout.trim()) {
    must('psql', [...psqlArgs('postgres', SUPERUSER), '-c', `CREATE DATABASE ${DB}`], {
      env: superEnv,
    });
  }

  // Roles: migrate owns the schema; runtime and identity are deliberately weak.
  const roleSql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oe_migrate') THEN
        CREATE ROLE oe_migrate LOGIN PASSWORD ${quote(creds.migrate.password)}
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oe_runtime') THEN
        CREATE ROLE oe_runtime LOGIN PASSWORD ${quote(creds.runtime.password)}
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oe_identity') THEN
        CREATE ROLE oe_identity LOGIN PASSWORD ${quote(creds.identity.password)}
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
      END IF;
    END
    $$;
    REVOKE ALL ON DATABASE ${DB} FROM PUBLIC;
    GRANT CONNECT ON DATABASE ${DB} TO oe_migrate, oe_runtime, oe_identity;
    -- Only the migration role may create schemas; runtime and identity never can.
    GRANT CREATE ON DATABASE ${DB} TO oe_migrate;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
  `;
  must('psql', [...psqlArgs(DB, SUPERUSER), '-c', roleSql], { env: superEnv });
  // pgcrypto supplies gen_random_uuid() to the budget command functions.
  must('psql', [...psqlArgs(DB, SUPERUSER), '-c', 'CREATE EXTENSION IF NOT EXISTS pgcrypto'], {
    env: superEnv,
  });

  writeEnvFile(creds);
  const version = must('psql', [...psqlArgs(DB, SUPERUSER), '-tAc', 'SHOW server_version'], {
    env: superEnv,
  });
  process.stdout.write(
    `Disposable PostgreSQL ${version.stdout.trim()} ready on ${socketDir}:${PORT}/${DB}\n` +
      `Wrote connection strings to .env.local (gitignored). Stop with: npm run db:down\n`,
  );
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function url(creds, role) {
  const host = encodeURIComponent(socketDir);
  return `postgresql://${creds[role].user}:${encodeURIComponent(creds[role].password)}@localhost:${PORT}/${DB}?host=${host}`;
}

function writeEnvFile(creds) {
  const body = [
    '# Generated by scripts/dev-postgres.mjs. Local disposable cluster only; gitignored.',
    'APP_ENV=local',
    'APP_ORIGIN=http://127.0.0.1:4173',
    'AUTH_MODE=fixture_local_only',
    `DATABASE_URL=${url(creds, 'runtime')}`,
    `MIGRATION_DATABASE_URL=${url(creds, 'migrate')}`,
    `IDENTITY_DATABASE_URL=${url(creds, 'identity')}`,
    'LEDGER_CURRENCY=USD',
    'LIVE_SPEND_LIMIT_MICRO=0',
    'CAPTURE_ADAPTER=local_fixture',
    'FIXTURE_ORIGIN=http://127.0.0.1:4179,http://127.0.0.1:4180',
    'LIVE_CAPTURE_ENABLED=false',
    'EVIDENCE_STORE=local_fs',
    'EVIDENCE_LOCAL_DIR=.local-evidence',
    'PUBLIC_INTAKE_ENABLED=false',
    'AUTOMATIC_OUTREACH_ENABLED=false',
    'AUTOMATIC_PRODUCTION_WRITES_ENABLED=false',
    'AUTOMATIC_TOPUPS_ENABLED=false',
    '',
  ].join('\n');
  writeFileSync(envFile, body, { mode: 0o600 });
}

function down({ purge }) {
  if (existsSync(dataDir) && isRunning()) {
    must('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
    process.stdout.write('Stopped disposable cluster.\n');
  } else {
    process.stdout.write('Disposable cluster is not running.\n');
  }
  if (purge) {
    rmSync(resolve(root, '.local-postgres'), { recursive: true, force: true });
    process.stdout.write('Purged .local-postgres/.\n');
  }
}

function status() {
  if (!existsSync(dataDir)) {
    process.stdout.write('No disposable cluster. Run: npm run db:up\n');
    return;
  }
  const result = run('pg_ctl', ['-D', dataDir, 'status']);
  process.stdout.write(result.stdout || result.stderr);
}

const command = process.argv[2] ?? 'status';
try {
  if (command === 'up') up();
  else if (command === 'down') down({ purge: process.argv.includes('--purge') });
  else if (command === 'status') status();
  else {
    process.stderr.write(`Unknown command ${command}. Use up | down [--purge] | status.\n`);
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
