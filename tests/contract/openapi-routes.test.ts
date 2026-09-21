import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp } from '@oe/api';
import type { AppDependencies } from '../../apps/api/src/context.ts';

/**
 * The routes the application actually mounts, against the contract it publishes.
 *
 * `apps/api/src/app.ts` says this file exists and asserts exactly this, so here it is. Two
 * ways to drift are covered: an operation in the contract nobody implemented, which promises
 * a client something that will 404, and a route in the app the contract never declared, which
 * is a surface nobody reviewed. The minimum role must match too — a route mounted a rank
 * lower than its contract says is a privilege bug that no request test would notice unless it
 * happened to try the wrong role.
 */

const spec = JSON.parse(
  readFileSync(new URL('../../contracts/openapi.json', import.meta.url), 'utf8'),
) as {
  paths: Record<string, Record<string, { 'x-minimum-role'?: string; operationId?: string }>>;
};

/** Built with a dependency object that is never called: only the route table is inspected. */
const app = createApp({} as AppDependencies);

interface MountedRoute {
  method: string;
  path: string;
}

/**
 * Hono exposes its mounted routes, including the middleware entries. Only handlers with a
 * concrete method are routes; `ALL` entries are the middleware chain.
 */
function mountedRoutes(instance: unknown): MountedRoute[] {
  const routes = (instance as { routes: { method: string; path: string }[] }).routes;
  const seen = new Set<string>();
  const out: MountedRoute[] = [];
  for (const route of routes) {
    if (route.method === 'ALL') continue;
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: route.method.toLowerCase(), path: route.path });
  }
  return out;
}

/**
 * `/api/v1/opportunities/:id/offers` → `/v1/opportunities/{id}/offers`.
 *
 * The public surface is mounted at `/public` with no `/api` prefix, so only the prefix that
 * is actually present is stripped.
 */
function toContractPath(path: string): string {
  return path.replace(/^\/api\/v1/, '/v1').replaceAll(/:([A-Za-z0-9_]+)/g, '{$1}');
}

const contractOperations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([, operation]) => typeof operation.operationId === 'string')
    .map(([method, operation]) => ({ method, path, role: operation['x-minimum-role'] })),
);

const implemented = mountedRoutes(app)
  .map((route) => ({ ...route, path: toContractPath(route.path) }))
  .filter((route) => route.path.startsWith('/v1/') || route.path.startsWith('/public/'));

describe('routes and contract', () => {
  it('implements every operation the served contract declares', () => {
    const mounted = new Set(implemented.map((route) => `${route.method} ${route.path}`));
    const missing = contractOperations
      .map((operation) => `${operation.method} ${operation.path}`)
      .filter((key) => !mounted.has(key));
    expect(missing).toEqual([]);
  });

  it('declares every v1 route it mounts', () => {
    const declared = new Set(
      contractOperations.map((operation) => `${operation.method} ${operation.path}`),
    );
    const undeclared = implemented
      .map((route) => `${route.method} ${route.path}`)
      .filter((key) => !declared.has(key));
    expect(undeclared).toEqual([]);
  });
});
