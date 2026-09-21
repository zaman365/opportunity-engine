import {
  claimDispatchWork,
  getOutboxEvent,
  getScan,
  markOutboxDelivered,
  markOutboxRetry,
  type Database,
} from '@oe/db';
import type { ScanRunner } from './runner.ts';

/**
 * Outbox dispatcher.
 *
 * ADR-002: "An outbox admission transaction closes the DB/workflow dual-write gap; a
 * scheduled dispatcher retries start and records provider instance ID."
 *
 * The claim step reads only routing keys (migration 0005). The payload, and therefore every
 * business fact, is read inside a tenant-scoped transaction under RLS. Duplicate delivery is
 * expected and harmless: the runner re-reads the scan and a terminal scan is a no-op.
 */
export interface DispatcherOptions {
  db: Database;
  runner: ScanRunner;
  batchSize?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  log?: (event: Record<string, unknown>) => void;
}

export class OutboxDispatcher {
  readonly #db: Database;
  readonly #runner: ScanRunner;
  readonly #batchSize: number;
  readonly #leaseSeconds: number;
  readonly #maxAttempts: number;
  readonly #log: (event: Record<string, unknown>) => void;

  constructor(options: DispatcherOptions) {
    this.#db = options.db;
    this.#runner = options.runner;
    this.#batchSize = options.batchSize ?? 5;
    this.#leaseSeconds = options.leaseSeconds ?? 60;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#log = options.log ?? (() => undefined);
  }

  /** Process at most one batch. Returns how many events reached a terminal outcome. */
  async tick(): Promise<number> {
    const work = await this.#db.withoutTenant((tx) =>
      claimDispatchWork(tx, { limit: this.#batchSize, leaseSeconds: this.#leaseSeconds }),
    );
    let handled = 0;
    for (const item of work) {
      try {
        const done = await this.#handle(item.tenant_id, item.outbox_id);
        if (done) handled += 1;
      } catch (error) {
        this.#log({ event: 'dispatch_failed', outbox_id: item.outbox_id, error: String(error) });
        await this.#db.withTenant(item.tenant_id, (tx) =>
          markOutboxRetry(tx, {
            id: item.outbox_id,
            // Exponential-ish backoff, bounded by the retry budget.
            delaySeconds: Math.min(60, 2 ** item.attempts),
            error: error instanceof Error ? error.message : String(error),
            maxAttempts: this.#maxAttempts,
          }),
        );
      }
    }
    return handled;
  }

  async #handle(tenantId: string, outboxId: string): Promise<boolean> {
    const event = await this.#db.withTenant(tenantId, (tx) => getOutboxEvent(tx, outboxId));
    if (!event) return false;
    if (event.status === 'delivered') return true;
    if (event.event_type !== 'scan.admitted') {
      this.#log({ event: 'unsupported_event', event_type: event.event_type });
      await this.#db.withTenant(tenantId, (tx) =>
        markOutboxDelivered(tx, { id: outboxId, providerInstanceId: null }),
      );
      return true;
    }

    const scanId = String(event.payload.scan_id);
    // Deterministic instance ID: before starting work we check the scan's recorded instance,
    // so a retry after a timed-out start cannot create a second run.
    const instanceId = await this.#db.withTenant(tenantId, async (tx) => {
      const scan = await getScan(tx, scanId);
      return scan?.workflow_instance_id ?? null;
    });

    const result = await this.#runner.run(tenantId, scanId);
    this.#log({ event: 'scan_finished', scan_id: scanId, state: result.state });

    await this.#db.withTenant(tenantId, (tx) =>
      markOutboxDelivered(tx, { id: outboxId, providerInstanceId: instanceId }),
    );
    return true;
  }
}
