import { createHash, randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getLedgerCurrency, resolveMemberships } from '@oe/db';
import type { AppDependencies, AppEnv } from './context.ts';
import { hasRole } from './context.ts';
import { ApiProblem } from './problem.ts';
import { originAllowed } from './auth.ts';

/** Attach a request ID that appears in every problem response and audit row. */
export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  c.set('requestId', id);
  c.header('x-request-id', id);
  await next();
};

/**
 * Baseline response headers.
 *
 * SECURITY.md: "Use CSP, nosniff, referrer protection and secure cookie settings." The API
 * returns JSON only, so its CSP forbids everything.
 */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
  // A route that serves an artifact sets a stricter, sandboxed policy of its own; this
  // baseline must not loosen it.
  if (!c.res.headers.has('content-security-policy')) {
    c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  }
};

/**
 * Authenticate, then resolve membership from application storage.
 *
 * These are two separate gates on purpose. A caller with a perfectly valid assertion and no
 * active membership gets 403, not a tenant.
 */
export function authenticate(deps: AppDependencies): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const identity = await deps.identity.verify(c.req.raw);
    if (!identity) {
      throw new ApiProblem('UNAUTHENTICATED', 'Sign in through the configured identity provider.');
    }
    const memberships = await deps.identityDb.withoutTenant((tx) =>
      resolveMemberships(tx, identity.issuer, identity.subject),
    );
    if (memberships.length === 0) {
      throw new ApiProblem(
        'MEMBERSHIP_REQUIRED',
        'This identity has no active membership. An owner must provision access.',
      );
    }
    // One workspace in M1. A membership chosen by a client-supplied header would be exactly
    // the untrusted tenant assertion AGENTS.md forbids.
    const membership = memberships[0]!;
    // The accounting currency lives on the tenant row, which the identity role cannot read.
    const ledgerCurrency = await deps.db.withTenant(membership.tenantId, (tx) => getLedgerCurrency(tx));
    if (!ledgerCurrency) {
      throw new ApiProblem('MEMBERSHIP_REQUIRED', 'This workspace is not fully configured.');
    }
    c.set('actor', { identity, membership: { ...membership, ledgerCurrency } });
    await next();
  };
}

/** Verify Origin and the session-bound CSRF token on every unsafe method. */
export function csrfGuard(deps: AppDependencies): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    if (!originAllowed(c.req.raw, deps.config.appOrigin)) {
      throw new ApiProblem('ORIGIN_NOT_ALLOWED', 'This request did not come from the application origin.');
    }
    const actor = c.get('actor');
    if (!deps.csrf.verify(actor.identity, c.req.header('x-csrf-token') ?? null)) {
      throw new ApiProblem(
        'CSRF_INVALID',
        'Reload the workspace to obtain a current session token, then retry.',
      );
    }
    await next();
  };
}

/** Enforce the minimum role the OpenAPI operation declares. */
export function requireRole(required: 'viewer' | 'operator' | 'reviewer' | 'owner'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { membership } = c.get('actor');
    if (!hasRole(membership.role, required)) {
      throw new ApiProblem(
        'ROLE_REQUIRED',
        `This action requires the ${required} role. Your membership is ${membership.role}.`,
      );
    }
    await next();
  };
}

/**
 * Read and validate an Idempotency-Key header plus the canonical hash of the request.
 *
 * API_GUIDE.md: "Idempotency scope is tenant + actor + operation + key; canonical request
 * hash binds body/path."
 */
export function idempotencyInput(
  key: string | undefined,
  canonical: unknown,
): { key: string; requestHash: string } {
  if (!key || key.length < 8 || key.length > 200) {
    throw new ApiProblem('INVALID_REQUEST', 'Idempotency-Key must be 8 to 200 characters.');
  }
  return { key, requestHash: canonicalHash(canonical) };
}

/** Stable hash over a JSON value with object keys sorted, so field order cannot change it. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Body size ceiling from API_GUIDE.md, applied before parsing. */
export const MAX_BODY_BYTES = 32 * 1024;

export async function readJsonBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    throw new ApiProblem('INVALID_REQUEST', 'Request body exceeds the 32 KiB limit.');
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiProblem('INVALID_REQUEST', 'Request body exceeds the 32 KiB limit.');
  }
  if (!text.trim()) throw new ApiProblem('INVALID_REQUEST', 'A JSON body is required.');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiProblem('INVALID_REQUEST', 'Request body is not valid JSON.');
  }
}
