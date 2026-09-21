/**
 * Local scan runner process.
 *
 * Polls the dispatch index and executes admitted scans. This is the development stand-in
 * for the Cloudflare Workflow binding described in ADR-002: the durable state lives in
 * PostgreSQL either way, so the workflow adapter can be swapped without changing the
 * business logic. No cloud resource is contacted.
 */
import {
  BrowserRunCaptureProvider,
  LocalFixtureCaptureProvider,
  createFixtureTargetPolicy,
  createPlaywrightRenderer,
  productionTargetPolicy,
} from '@oe/capture';
import { Database, loadDotEnv } from '@oe/db';
import { LocalFsEvidenceStore, UnconfiguredR2EvidenceStore } from '@oe/evidence';
import { loadConfig } from '@oe/domain';
import { createServer } from 'node:http';
import { OutboxDispatcher } from './dispatcher.ts';
import { ScanRunner } from './runner.ts';

loadDotEnv();
const config = loadConfig(process.env as Record<string, string | undefined>);
const db = new Database({
  connectionString: config.databaseUrl,
  applicationName: 'oe-scan-runner',
});

const capture =
  config.capture.adapter === 'local_fixture'
    ? new LocalFixtureCaptureProvider(
        config.capture.fixtureOrigins,
        await createPlaywrightRenderer(),
      )
    : new BrowserRunCaptureProvider({
        endpoint: process.env.BROWSER_RUN_ENDPOINT ?? null,
        egressProofRecorded: process.env.BROWSER_RUN_EGRESS_PROOF === 'recorded',
      });

const evidence =
  config.evidence.store === 'local_fs'
    ? new LocalFsEvidenceStore(config.evidence.localDir!)
    : new UnconfiguredR2EvidenceStore();

const targetPolicy =
  config.capture.adapter === 'local_fixture'
    ? createFixtureTargetPolicy(config.capture.fixtureOrigins)
    : productionTargetPolicy;

const runner = new ScanRunner({ db, capture, targetPolicy, evidence, now: () => new Date() });
const dispatcher = new OutboxDispatcher({
  db,
  runner,
  log: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
});

/**
 * A loopback health endpoint.
 *
 * The runner has no request surface of its own, but something has to be able to tell
 * whether it is alive — a process supervisor, and the browser test harness, which would
 * otherwise mistake the API's health for the runner's and start no runner at all.
 */
const healthPort = Number(process.env.RUNNER_HEALTH_PORT ?? 4175);
const health = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ status: 'healthy', capture: capture.kind, configured: capture.configured }),
    );
    return;
  }
  response.writeHead(404).end();
});
health.listen(healthPort, '127.0.0.1');

/**
 * Idle backoff.
 *
 * A flat one-second poll is ~86,000 ticks a day, and each tick is a transaction — three
 * statements. That alone exceeds Hyperdrive's 100,000 queries/day on the Cloudflare free plan
 * before a single scan runs. Backing off to 15s while the queue is empty costs nothing in
 * responsiveness, because an admitted scan wakes the loop on the next tick either way and a
 * deployed build starts its workflow directly from the admission transaction.
 *
 * `RUNNER_IDLE_MAX_MS` lowers the ceiling for local development, where a 15-second wait
 * between clicking "scan" and seeing it run is just friction. It never raises it.
 */
const BUSY_MS = 100;
const IDLE_START_MS = 1_000;
const IDLE_MAX_MS = Math.min(15_000, Number(process.env.RUNNER_IDLE_MAX_MS ?? 15_000));

let idleDelay = IDLE_START_MS;
let running = true;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    running = false;
  });
}

process.stdout.write(
  `scan-runner started · capture=${capture.kind} configured=${capture.configured} evidence=${evidence.kind}\n` +
    `  health on http://127.0.0.1:${healthPort}/health\n`,
);
while (running) {
  const handled = await dispatcher.tick();
  if (handled > 0) {
    idleDelay = IDLE_START_MS;
  } else {
    idleDelay = Math.min(idleDelay * 2, IDLE_MAX_MS);
  }
  await new Promise((resolve) => setTimeout(resolve, handled > 0 ? BUSY_MS : idleDelay));
}
health.close();
await db.close();
