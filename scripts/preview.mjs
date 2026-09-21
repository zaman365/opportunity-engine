#!/usr/bin/env node
/**
 * Bring the whole local stack up with one command, and populate it so there is something to
 * look at.
 *
 * Starts the disposable database, applies migrations, seeds the synthetic tenants, starts both
 * fixture sites, the API, the scan runner and the operator UI, waits for each to actually
 * answer, then runs a handful of demo scans so the review queue is not empty.
 *
 * Everything here is local and synthetic. The fixture sites bind loopback only, the capture
 * adapter refuses any origin but theirs, and `loadConfig` rejects this entire mode outside
 * APP_ENV=local. No real website is contacted and nothing is deployed.
 *
 * `--no-demo` skips the demo scans. `--fresh` rebuilds the database from empty first.
 * `--force` reclaims ports a previous run left behind.
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runDemo = !process.argv.includes('--no-demo');
const fresh = process.argv.includes('--fresh');
const force = process.argv.includes('--force');

const OPERATOR = 'http://127.0.0.1:4173';
const API = 'http://127.0.0.1:4174';
const RUNNER = 'http://127.0.0.1:4175';
const KIT_FIXTURES = 'http://127.0.0.1:4179';
const M2_FIXTURES = 'http://127.0.0.1:4180';

const children = [];
let shuttingDown = false;

function step(message) {
  process.stdout.write(`[2m·[0m ${message}\n`);
}

function run(script, args = []) {
  const result = spawnSync('npm', ['run', script, ...args], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(`\n"npm run ${script}" failed:\n${result.stdout}\n${result.stderr}\n`);
    process.exit(1);
  }
  return result.stdout;
}

/** Start a long-running server and keep a handle so Ctrl+C takes it down with us. */
function serve(name, script) {
  const child = spawn('npm', ['run', script], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The runner backs off to 15s when idle to stay inside Cloudflare's free query budget.
    // Locally that is just a wait between clicking scan and seeing it run.
    env: { ...process.env, RUNNER_IDLE_MAX_MS: '750' },
  });
  children.push({ name, child });
  // Server output is noise until something breaks, so only failures reach the terminal.
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (/error|EADDRINUSE|failed/i.test(text)) process.stderr.write(`[${name}] ${text}`);
  });
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) {
      process.stderr.write(`\n[${name}] exited with code ${code}. Shutting the preview down.\n`);
      shutdown(1);
    }
  });
  return child;
}

async function waitFor(name, url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${name} did not answer at ${url} within ${timeoutMs / 1000}s.`);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write('\nStopping the preview…\n');
  for (const { child } of children) child.kill('SIGTERM');
  // The database keeps running: it is disposable but rebuilding it every time is slow.
  process.stdout.write('The local database is still running. Stop it with: npm run db:down\n');
  setTimeout(() => process.exit(code), 400);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));

/* --------------------------------------------------------------- port check */

/**
 * Refuse to start on top of a process we do not own.
 *
 * Without this the preview quietly adopts whatever is already listening — a stale API from an
 * earlier session, say — and then Ctrl+C leaves it running while the operator talks to code
 * that is not the code in the working tree. Failing loudly is the honest behaviour.
 */
const PORTS = [
  { port: 4173, what: 'operator UI' },
  { port: 4174, what: 'API' },
  { port: 4175, what: 'scan runner' },
  { port: 4179, what: 'kit fixture site' },
  { port: 4180, what: 'M2 fixture site' },
];

const occupied = PORTS.filter(({ port }) => {
  const result = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().length > 0;
});

if (occupied.length > 0) {
  if (!force) {
    process.stderr.write(
      `\nThese ports are already in use by something this preview did not start:\n` +
        occupied.map(({ port, what }) => `  ${port}  (${what})`).join('\n') +
        `\n\nStop them, or rerun with --force to reclaim them:\n  npm run preview -- --force\n\n`,
    );
    process.exit(1);
  }
  step(`reclaiming ${occupied.length} port(s) from a previous run`);
  for (const { port } of occupied) {
    const pids = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .stdout.split('\n')
      .map((pid) => pid.trim())
      .filter(Boolean);
    for (const pid of pids) spawnSync('kill', [pid]);
  }
  // Give the kernel a moment to release the sockets before we bind them.
  await new Promise((r) => setTimeout(r, 1500));
}

/* ------------------------------------------------------------------ database */

step('starting the disposable PostgreSQL cluster');
if (fresh)
  spawnSync('node', ['scripts/dev-postgres.mjs', 'down', '--purge'], {
    cwd: root,
    stdio: 'ignore',
  });
run('db:up');
step('applying migrations');
run('db:migrate');
step('seeding the synthetic tenants');
run('db:seed');

/* ------------------------------------------------------------------- servers */

step('starting fixture sites, API, scan runner and the operator UI');
serve('fixtures', 'fixtures');
serve('fixtures:m2', 'fixtures:m2');
serve('api', 'dev:api');
serve('runner', 'dev:runner');
serve('operator', 'dev:operator');

await Promise.all([
  waitFor('kit fixture site', `${KIT_FIXTURES}/product`),
  waitFor('M2 fixture site', `${M2_FIXTURES}/product-healthy`),
  waitFor('API', `${API}/api/health`),
  waitFor('scan runner', `${RUNNER}/health`),
  waitFor('operator UI', OPERATOR),
]);

/* --------------------------------------------------------------- demo scans */

const ACCOUNT = '11111111-1111-4111-8111-000000000010';
const VENTURE = '11111111-1111-4111-8111-000000000001';
const AUTHORIZATION = '11111111-1111-4111-8111-000000000020';

const DEMO = [
  {
    label: 'broken size-guide link',
    url: `${KIT_FIXTURES}/product`,
    detectors: ['MF-LINK-01'],
    pages: 2,
  },
  {
    label: 'broken product image',
    url: `${M2_FIXTURES}/product-broken-image`,
    detectors: ['MF-ASSET-01'],
    pages: 1,
  },
  {
    label: 'healthy page, no defect',
    url: `${M2_FIXTURES}/product-healthy`,
    detectors: ['MF-ASSET-01'],
    pages: 1,
  },
  {
    label: 'slow image, cannot judge',
    url: `${M2_FIXTURES}/product-lazy`,
    detectors: ['MF-ASSET-01'],
    pages: 1,
  },
  {
    label: 'access challenge, blocked',
    url: `${KIT_FIXTURES}/challenge`,
    detectors: ['MF-LINK-01'],
    pages: 2,
  },
];

if (runDemo) {
  step(`running ${DEMO.length} demo scans against the fixture sites`);
  const headers = { 'x-fixture-subject': 'operator@fixture.test' };
  const session = await (await fetch(`${API}/api/v1/session`, { headers })).json();

  for (const demo of DEMO) {
    const response = await fetch(`${API}/api/v1/scans`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        origin: OPERATOR,
        'x-csrf-token': session.csrf_token,
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        account_id: ACCOUNT,
        venture_id: VENTURE,
        target_url: demo.url,
        authorization_id: AUTHORIZATION,
        max_unique_pages: demo.pages,
        detectors: demo.detectors,
        max_cost: { currency: 'USD', amount_micro: '100000' },
      }),
    });
    if (!response.ok) {
      const problem = await response.json();
      process.stderr.write(
        `  demo scan "${demo.label}" was refused: ${problem.code} ${problem.detail}\n`,
      );
      continue;
    }
    const { id } = await response.json();
    // Wait for the runner to finish so the queue is populated when the browser opens.
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const scan = await (await fetch(`${API}/api/v1/scans/${id}`, { headers })).json();
      if (!['queued', 'validating', 'capturing', 'analysing'].includes(scan.state)) {
        process.stdout.write(`  [2m${demo.label.padEnd(28)}[0m ${scan.state}\n`);
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/* ------------------------------------------------------------------- ready */

process.stdout.write(`
[1mPreview ready[0m   ${OPERATOR}

  Sign in as any seeded identity — role and workspace come from the database,
  not from the choice:

    owner@fixture.test      cost limits, accounts, authorizations
    operator@fixture.test   start and cancel scans
    reviewer@fixture.test   confirm findings, build and publish reports
    viewer@fixture.test     read only

  Worth a look:
    ${OPERATOR}/opportunities     the review queue
    ${OPERATOR}/scans             what ran, what it covered, what it cost
    ${OPERATOR}/settings          cost limits and what this build cannot do
    ${OPERATOR}/design-studies    the two composition studies from D0

  Everything is synthetic and local. The fixture sites are on
  ${KIT_FIXTURES} and ${M2_FIXTURES};
  no real website is contacted.

  Ctrl+C to stop.
`);
