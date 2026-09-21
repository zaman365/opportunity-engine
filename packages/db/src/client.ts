import pg from 'pg';

/**
 * Database access with a transaction-scoped tenant context.
 *
 * DATA_MODEL.md: "After resolution, begin a transaction and use
 * `SELECT set_config('oe.tenant_id', $1, true)`. The final `true` makes context
 * transaction-local. Perform scoped statements in that transaction with a non-owner,
 * non-superuser, non-BYPASSRLS role. No context means no row visibility."
 *
 * Every tenant-scoped statement therefore goes through {@link Database.withTenant}. There is
 * no ambient connection whose context might survive into the next pooled checkout.
 */

export type Row = object;

export interface QueryExecutor {
  query<T extends Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

/** Postgres error codes the application maps to specific API problems. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  INSUFFICIENT_PRIVILEGE: '42501',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  NO_DATA_FOUND: 'P0002',
} as const;

export interface PgError extends Error {
  code?: string;
  constraint?: string;
}

export function isPgError(error: unknown): error is PgError {
  return error instanceof Error && typeof (error as PgError).code === 'string';
}

/**
 * The command functions in migration 0003 raise their failure as the exception message.
 * This pulls that stable token out so the API can map it to a problem code without
 * ever showing a raw database message to a user.
 */
export function ledgerErrorCode(error: unknown): string | null {
  if (!isPgError(error)) return null;
  const match = /^([A-Z_]{4,40})\b/.exec(error.message);
  return match ? match[1]! : null;
}

export interface DatabaseOptions {
  connectionString: string;
  /** Keep the local pool small: concurrency tests need predictable connection counts. */
  max?: number;
  applicationName?: string;
  statementTimeoutMs?: number;
}

export class Database {
  readonly pool: pg.Pool;

  constructor(options: DatabaseOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 8,
      application_name: options.applicationName ?? 'opportunity-engine',
      statement_timeout: options.statementTimeoutMs ?? 15_000,
      idle_in_transaction_session_timeout: 30_000,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Run `fn` inside a transaction with no tenant context. Used for identity resolution and
   * dispatcher bookkeeping only; RLS makes every tenant-scoped table return zero rows here.
   */
  async withoutTenant<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client as unknown as QueryExecutor);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Run `fn` inside a transaction whose tenant context is `tenantId`.
   *
   * The context is set with `set_config(..., true)` so it is discarded at commit or
   * rollback and cannot leak to the next user of a pooled connection. `verifyContextReset`
   * in the database tests asserts that property against a real pool.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: QueryExecutor) => Promise<T>,
    options: { isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {},
  ): Promise<T> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw new TypeError('tenantId must be a UUID resolved from verified membership.');
    }
    const client = await this.pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${(options.isolation ?? 'read committed').toUpperCase()}`);
      await client.query('SELECT set_config($1, $2, true)', ['oe.tenant_id', tenantId]);
      const result = await fn(client as unknown as QueryExecutor);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retry a transaction on serialization failure or deadlock, as DATA_MODEL.md requires for
   * the admission path. Only these two codes retry: a budget or version conflict is a real
   * answer, not a transient fault.
   */
  async withTenantRetry<T>(
    tenantId: string,
    fn: (tx: QueryExecutor) => Promise<T>,
    options: { attempts?: number; isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {},
  ): Promise<T> {
    const attempts = options.attempts ?? 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const opts = options.isolation ? { isolation: options.isolation } : {};
        return await this.withTenant(tenantId, fn, opts);
      } catch (error) {
        lastError = error;
        const code = isPgError(error) ? error.code : undefined;
        if (code !== PG_ERROR.SERIALIZATION_FAILURE && code !== PG_ERROR.DEADLOCK_DETECTED) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 15));
      }
    }
    throw lastError;
  }
}
