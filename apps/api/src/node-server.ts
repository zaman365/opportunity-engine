/**
 * Node entry point for local development.
 *
 * The Hono app itself is runtime-agnostic (`fetch(Request) => Response`), so the same app
 * object is what a Worker would export. No Worker deployment is configured: ADR-009 keeps
 * production release behind owner authorization.
 */
import { serve } from '@hono/node-server';
import { loadDotEnv } from '@oe/db';
import { createApp } from './app.ts';
import { buildDependencies } from './bootstrap.ts';

loadDotEnv();

const deps = await buildDependencies();
const app = createApp(deps);
const port = Number(process.env.API_PORT ?? 4174);

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  process.stdout.write(
    `API listening on http://127.0.0.1:${info.port}\n` +
      `  environment=${deps.config.environment} auth=${deps.config.authMode}\n` +
      `  capture=${deps.capture.kind} configured=${deps.capture.configured}\n` +
      `  evidence=${deps.evidence.kind} available=${deps.evidence.available}\n`,
  );
});
