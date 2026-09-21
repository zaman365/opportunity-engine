import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createApp } from '@oe/api';
import {
  LocalFixtureCaptureProvider,
  createFixtureTargetPolicy,
  createPlaywrightRenderer,
} from '@oe/capture';
import { CsrfTokens, FixtureLocalIdentityProvider } from '../../apps/api/src/auth.ts';
import type { AppDependencies } from '../../apps/api/src/context.ts';
import { RecordedLocalChannel } from '@oe/notify';
import { OutboxDispatcher, ScanRunner } from '@oe/scan-runner';
import { freshHarness, LOCAL_FIXTURE, type Harness } from './harness.ts';

/**
 * Builds the real Hono app with real adapters against the disposable database, plus the
 * kit's loopback fixture site and the scan runner.
 *
 * Nothing is mocked: requests go through authentication, membership resolution, CSRF, the
 * transactional ledger and the durable outbox exactly as they would in `npm run dev:api`.
 */

const FIXTURE_ORIGIN = 'http://127.0.0.1:4179';
/** The M2 product-image fixtures live on their own port; see fixtures/m2-server.mjs. */
const M2_FIXTURE_ORIGIN = 'http://127.0.0.1:4180';
const FIXTURE_ORIGINS = [FIXTURE_ORIGIN, M2_FIXTURE_ORIGIN];

export interface ApiHarness extends Harness {
  deps: AppDependencies;
  app: ReturnType<typeof createApp>;
  runner: ScanRunner;
  dispatcher: OutboxDispatcher;
  request(
    path: string,
    init?: RequestInit & { subject?: string; csrf?: boolean },
  ): Promise<Response>;
  json<T = unknown>(response: Response): Promise<T>;
  /** Drain the outbox until it is empty or the budget is exhausted. */
  drain(maxTicks?: number): Promise<void>;
  stop(): Promise<void>;
}

const fixtureServers: ChildProcess[] = [];

const SITES = [
  {
    script: 'opportunity-engine-build-kit/fixtures/server.mjs',
    probe: `${FIXTURE_ORIGIN}/product`,
  },
  { script: 'fixtures/m2-server.mjs', probe: `${M2_FIXTURE_ORIGIN}/product-healthy` },
];

export async function startFixtureSite(): Promise<void> {
  for (const site of SITES) {
    if (await reachable(site.probe)) continue;
    fixtureServers.push(spawn('node', [site.script], { stdio: 'ignore', detached: false }));
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const up = await Promise.all(SITES.map((site) => reachable(site.probe)));
    if (up.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    'A local fixture site did not start. Run `npm run fixtures` and `npm run fixtures:m2`.',
  );
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) });
    return response.status === 200;
  } catch {
    return false;
  }
}

export function stopFixtureSite(): void {
  for (const server of fixtureServers) server.kill('SIGTERM');
  fixtureServers.length = 0;
}

export async function createApiHarness(
  overrides: Partial<AppDependencies> = {},
): Promise<ApiHarness> {
  await startFixtureSite();
  const base = await freshHarness();

  const identity = new FixtureLocalIdentityProvider(base.config);
  const csrf = new CsrfTokens('local-test-secret');
  const capture = new LocalFixtureCaptureProvider(
    FIXTURE_ORIGINS,
    await createPlaywrightRenderer(),
  );

  const deps: AppDependencies = {
    config: base.config,
    db: base.db,
    identityDb: base.identityDb,
    identity,
    csrf,
    capture,
    targetPolicy: createFixtureTargetPolicy(FIXTURE_ORIGINS),
    evidence: base.evidence,
    // Returns the code to the caller and sends nothing. It refuses to construct outside
    // APP_ENV=local, which is what keeps that acceptable.
    verification: new RecordedLocalChannel(base.config.environment),
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };

  const app = createApp(deps);
  const runner = new ScanRunner({
    db: deps.db,
    capture: deps.capture,
    targetPolicy: deps.targetPolicy,
    evidence: deps.evidence,
    now: deps.now,
  });
  const dispatcher = new OutboxDispatcher({ db: deps.db, runner });

  async function request(
    path: string,
    init: RequestInit & { subject?: string; csrf?: boolean } = {},
  ): Promise<Response> {
    const { subject = 'operator@fixture.test', csrf: withCsrf = true, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (subject) headers.set(FixtureLocalIdentityProvider.HEADER, subject);
    if (!headers.has('origin')) headers.set('origin', base.config.appOrigin);
    if (rest.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const method = (rest.method ?? 'GET').toUpperCase();
    if (withCsrf && method !== 'GET' && method !== 'HEAD') {
      headers.set(
        'x-csrf-token',
        csrf.issue({ issuer: FixtureLocalIdentityProvider.ISSUER, subject: subject || 'unknown' }),
      );
    }
    if (method !== 'GET' && method !== 'HEAD' && !headers.has('idempotency-key')) {
      headers.set('idempotency-key', randomUUID());
    }
    return app.fetch(new Request(`${base.config.appOrigin}${path}`, { ...rest, headers }));
  }

  return {
    ...base,
    deps,
    app,
    runner,
    dispatcher,
    request,
    json: async <T>(response: Response) => (await response.json()) as T,
    async drain(maxTicks = 10) {
      for (let i = 0; i < maxTicks; i += 1) {
        const handled = await dispatcher.tick();
        if (handled === 0) return;
      }
    },
    async stop() {
      await base.close();
    },
  };
}

export { LOCAL_FIXTURE };

/** A CreateScan body pointing at the kit's known-positive fixture product page. */
export function scanRequest(overrides: Record<string, unknown> = {}) {
  return {
    account_id: LOCAL_FIXTURE.accountA,
    venture_id: LOCAL_FIXTURE.ventureA,
    target_url: `${FIXTURE_ORIGIN}/product`,
    authorization_id: LOCAL_FIXTURE.authorizationA,
    max_unique_pages: 2,
    detectors: ['MF-LINK-01'],
    max_cost: { currency: 'USD', amount_micro: '100000' },
    ...overrides,
  };
}

export const FIXTURE_SITE_ORIGIN = FIXTURE_ORIGIN;
export const M2_FIXTURE_SITE_ORIGIN = M2_FIXTURE_ORIGIN;
