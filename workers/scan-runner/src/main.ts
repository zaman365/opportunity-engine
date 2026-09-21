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
const db = new Database({ connectionString: config.databaseUrl, applicationName: 'oe-scan-runner' });

const capture =
  config.capture.adapter === 'local_fixture'
    ? new LocalFixtureCaptureProvider(config.capture.fixtureOrigin!, await createPlaywrightRenderer())
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
    ? createFixtureTargetPolicy(config.capture.fixtureOrigin!)
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
    response.end(JSON.stringify({ status: 'healthy', capture: capture.kind, configured: capture.configured }));
    return;
  }
  response.writeHead(404).end();
});
health.listen(healthPort, '127.0.0.1');

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
  await new Promise((resolve) => setTimeout(resolve, handled > 0 ? 100 : 1000));
}
health.close();
await db.close();
