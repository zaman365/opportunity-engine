import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Finding, Report, Scan } from '@oe/contracts';
import { BrowserRunCaptureProvider, LocalFixtureCaptureProvider } from '@oe/capture';
import { ScanRunner } from '@oe/scan-runner';
import { listBudgets, setBudgetPaused } from '@oe/db';
import { loadConfig } from '@oe/domain';
import { FixtureLocalIdentityProvider } from '../../apps/api/src/auth.ts';
import {
  createApiHarness,
  FIXTURE_SITE_ORIGIN,
  LOCAL_FIXTURE,
  scanRequest,
  stopFixtureSite,
  type ApiHarness,
} from '../support/api-harness.ts';

/**
 * M1 acceptance tests beyond the happy path.
 *
 * M1_ONE_REAL_JOURNEY.md lists: "healthy negative; target challenge; missing second capture;
 * expired permission; cap exceeded; duplicate scan admission; process restart; cancelled
 * work; stale review; rejected finding excluded from report; unconfigured adapter; fixture
 * auth denied in deployment."
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
}, 180_000);

afterAll(async () => {
  await h?.stop();
  stopFixtureSite();
});

async function runScan(body: Record<string, unknown> = {}): Promise<Scan> {
  const response = await h.request('/api/v1/scans', {
    method: 'POST',
    body: JSON.stringify(scanRequest(body)),
  });
  expect(response.status).toBe(202);
  const admitted = await h.json<Scan>(response);
  await h.drain();
  return h.json<Scan>(await h.request(`/api/v1/scans/${admitted.id}`));
}

describe('detector negative controls', () => {
  it('reports no supported defect when the linked guide loads', async () => {
    const scan = await runScan({ target_url: `${FIXTURE_SITE_ORIGIN}/healthy-product` });
    expect(scan.state).toBe('succeeded');
    expect(scan.finding_ids).toHaveLength(0);
    expect(scan.coverage.reasons.join(' ')).toMatch(/loaded in both recorded checks/i);
  });

  it('produces a report that states the scope-limited absence of a defect', async () => {
    const scan = await runScan({ target_url: `${FIXTURE_SITE_ORIGIN}/healthy-product` });
    const created = await h.request('/api/v1/reports', {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        account_id: LOCAL_FIXTURE.accountA,
        scan_id: scan.id,
        finding_versions: [],
        language: 'en',
        scope_summary: 'We inspected this page and its linked fit guide.',
      }),
    });
    expect(created.status).toBe(201);
    const report = await h.json<Report>(created);
    const payload = await h.json<{
      body: {
        no_supported_defect: boolean;
        confirmed_findings: unknown[];
        limitations: string[];
        exclusions: string[];
        scope_summary: string;
        inspected: { partial_reasons: string[] };
      };
    }>(await h.request(`/api/v1/reports/${report.id}`));
    expect(payload.body.no_supported_defect).toBe(true);
    expect(payload.body.confirmed_findings).toHaveLength(0);
    // COPY.md: scope-limited absence, never a clean bill of health. The narrative fields
    // are what a customer reads, so they are what must stay free of reassurance language.
    const narrative = JSON.stringify({
      limitations: payload.body.limitations,
      exclusions: payload.body.exclusions,
      scope_summary: payload.body.scope_summary,
      partial_reasons: payload.body.inspected.partial_reasons,
    });
    expect(narrative).not.toMatch(/healthy|no issues|all good|everything works/i);
  });

  it('abstains on an access challenge instead of asserting a defect', async () => {
    const scan = await runScan({ target_url: `${FIXTURE_SITE_ORIGIN}/challenge` });
    // The challenge answers for the source page itself, so nothing comparable was captured.
    expect(['partial', 'blocked']).toContain(scan.state);
    expect(scan.finding_ids).toHaveLength(0);
    const text = scan.coverage.reasons.join(' ');
    expect(text).toMatch(/access check|could not be captured/i);
    expect(text).not.toMatch(/404|defect|broken/i);
  });
});

describe('permission and cost gates at execution time', () => {
  it('blocks a scan whose authorization was revoked after admission', async () => {
    const admitted = await h.json<Scan>(
      await h.request('/api/v1/scans', { method: 'POST', body: JSON.stringify(scanRequest()) }),
    );
    await h.db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
      tx.query('UPDATE oe.authorizations SET revoked_at = now() WHERE id = $1', [
        LOCAL_FIXTURE.authorizationA,
      ]),
    );
    await h.drain();
    const scan = await h.json<Scan>(await h.request(`/api/v1/scans/${admitted.id}`));
    expect(scan.state).toBe('blocked');
    expect(scan.blocked_reason).toMatch(/authorization is revoked/i);
    expect(scan.coverage.captured_unique_pages).toBe(0);

    await h.db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
      tx.query('UPDATE oe.authorizations SET revoked_at = NULL WHERE id = $1', [
        LOCAL_FIXTURE.authorizationA,
      ]),
    );
  });

  it('refuses admission when a covering cost limit is paused', async () => {
    const tenantBudget = await h.db.withTenant(LOCAL_FIXTURE.tenantA, async (tx) =>
      (await listBudgets(tx)).find((b) => b.scope_kind === 'tenant')!,
    );
    await h.db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
      setBudgetPaused(tx, {
        budgetId: tenantBudget.id,
        expectedVersion: tenantBudget.version,
        paused: true,
      }),
    );
    try {
      const response = await h.request('/api/v1/scans', {
        method: 'POST',
        body: JSON.stringify(scanRequest()),
      });
      expect(response.status).toBe(409);
      expect((await h.json<{ code: string }>(response)).code).toBe('BUDGET_PAUSED');

      // No scan row was created for a refused admission.
      const scans = await h.json<{ items: Scan[] }>(await h.request('/api/v1/scans'));
      expect(
        scans.items.some(
          (s) =>
            s.state === 'queued' &&
            s.coverage.captured_unique_pages === 0 &&
            s.blocked_reason === null,
        ),
      ).toBe(scans.items.some((s) => s.state === 'queued'));
    } finally {
      const paused = await h.db.withTenant(LOCAL_FIXTURE.tenantA, async (tx) =>
        (await listBudgets(tx)).find((b) => b.id === tenantBudget.id)!,
      );
      await h.db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
        setBudgetPaused(tx, {
          budgetId: paused.id,
          expectedVersion: paused.version,
          paused: false,
        }),
      );
    }
  });

  it('refuses a scan limit below the worst-case provider cost', async () => {
    // A live adapter with a nonzero worst case makes the ceiling meaningful.
    const liveConfig = { ...h.deps.config, liveSpendLimitMicro: '250000' };
    const strict = await createApiHarnessWithPrice(liveConfig.liveSpendLimitMicro);
    try {
      const response = await strict.request('/api/v1/scans', {
        method: 'POST',
        body: JSON.stringify(scanRequest({ max_cost: { currency: 'USD', amount_micro: '1000' } })),
      });
      expect(response.status).toBe(409);
      expect((await strict.json<{ code: string }>(response)).code).toBe('BUDGET_EXCEEDED');
    } finally {
      await strict.stop();
    }
  });
});

/** Run one statement batch as the migration role, for setup a runtime role cannot do. */
async function withMigrationConnection(
  fn: (client: InstanceType<typeof import('pg').default.Client>) => Promise<void>,
) {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL! });
  await client.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** A harness whose capture adapter reports a nonzero worst-case price. */
async function createApiHarnessWithPrice(worstCaseMicro: string): Promise<ApiHarness> {
  const harness = await createApiHarness();
  const priced = new LocalFixtureCaptureProvider(FIXTURE_SITE_ORIGIN, null);
  // The admission path reads the worst case from config for a non-fixture adapter, so this
  // stand-in reports itself as browser_run while still serving the loopback fixture.
  Object.defineProperty(priced, 'kind', { value: 'browser_run' });
  harness.deps.capture = priced;
  harness.deps.config = { ...harness.deps.config, liveSpendLimitMicro: worstCaseMicro };
  return harness;
}

describe('cancellation', () => {
  it('stops new work and records that incurred cost is unaffected', async () => {
    const admitted = await h.json<Scan>(
      await h.request('/api/v1/scans', { method: 'POST', body: JSON.stringify(scanRequest()) }),
    );
    const cancelled = await h.request(`/api/v1/scans/${admitted.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ expected_version: admitted.version }),
    });
    expect(cancelled.status).toBe(202);
    const scan = await h.json<Scan>(cancelled);
    expect(scan.state).toBe('cancel_requested');
    expect(scan.coverage.reasons.join(' ')).toMatch(/In-flight provider cost may still settle/i);

    await h.drain();
    const settled = await h.json<Scan>(await h.request(`/api/v1/scans/${admitted.id}`));
    expect(settled.state).toBe('cancelled');
    expect(settled.coverage.captured_unique_pages).toBe(0);
  });

  it('refuses to cancel on a stale version', async () => {
    const admitted = await h.json<Scan>(
      await h.request('/api/v1/scans', { method: 'POST', body: JSON.stringify(scanRequest()) }),
    );
    const response = await h.request(`/api/v1/scans/${admitted.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ expected_version: admitted.version + 7 }),
    });
    expect(response.status).toBe(409);
    await h.drain();
  });
});

describe('duplicate delivery and restart', () => {
  it('produces one set of evidence even when the same event is dispatched twice', async () => {
    const admitted = await h.json<Scan>(
      await h.request('/api/v1/scans', { method: 'POST', body: JSON.stringify(scanRequest()) }),
    );
    await h.drain();
    const first = await h.json<Scan>(await h.request(`/api/v1/scans/${admitted.id}`));
    const evidenceCount = first.evidence_ids.length;
    const findingCount = first.finding_ids.length;

    // Replay the outbox row as if the dispatcher had redelivered it after a crash.
    await h.db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
      tx.query(
        `UPDATE oe.outbox SET status = 'pending', available_at = now(), lease_until = NULL
          WHERE aggregate_id = $1`,
        [admitted.id],
      ),
    );
    await h.drain();

    const second = await h.json<Scan>(await h.request(`/api/v1/scans/${admitted.id}`));
    expect(second.evidence_ids).toHaveLength(evidenceCount);
    expect(second.finding_ids).toHaveLength(findingCount);
    expect(second.state).toBe(first.state);
  });

  it('resumes a scan that was admitted before the process restarted', async () => {
    const admitted = await h.json<Scan>(
      await h.request('/api/v1/scans', { method: 'POST', body: JSON.stringify(scanRequest()) }),
    );
    // A fresh runner object stands in for a restarted worker: the state is in the database.
    const restarted = new ScanRunner({
      db: h.deps.db,
      capture: h.deps.capture,
      targetPolicy: h.deps.targetPolicy,
      evidence: h.deps.evidence,
      now: h.deps.now,
    });
    const result = await restarted.run(LOCAL_FIXTURE.tenantA, admitted.id);
    expect(result.state).toBe('succeeded');

    // And running it again is a no-op rather than a second capture.
    const again = await restarted.run(LOCAL_FIXTURE.tenantA, admitted.id);
    expect(again.state).toBe('succeeded');
    const scan = await h.json<Scan>(await h.request(`/api/v1/scans/${admitted.id}`));
    expect(scan.evidence_ids).toHaveLength(4);
  });
});

describe('review integrity', () => {
  it('excludes a rejected finding from any report', async () => {
    const scan = await runScan();
    const findingId = scan.finding_ids[0]!;
    const rejected = await h.json<Finding>(
      await h.request(`/api/v1/findings/${findingId}/review`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({
          expected_version: 1,
          decision: 'reject',
          reason: 'The destination is intentionally missing in this fixture.',
          acknowledged_limitations: true,
        }),
      }),
    );
    expect(rejected.state).toBe('rejected');

    const response = await h.request('/api/v1/reports', {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        account_id: LOCAL_FIXTURE.accountA,
        scan_id: scan.id,
        finding_versions: [{ finding_id: findingId, version: rejected.version }],
        language: 'en',
        scope_summary: 'Attempt to publish a rejected finding.',
      }),
    });
    expect(response.status).toBe(422);
    expect((await h.json<{ code: string }>(response)).code).toBe('EVIDENCE_INCOMPLETE');
  });

  it('keeps a rejected finding as immutable audit history', async () => {
    const scan = await runScan();
    const findingId = scan.finding_ids[0]!;
    await h.request(`/api/v1/findings/${findingId}/review`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        expected_version: 1,
        decision: 'reject',
        reason: 'Rejecting to check that the record survives.',
        acknowledged_limitations: true,
      }),
    });
    const detail = await h.json<{ finding: Finding }>(
      await h.request(`/api/v1/findings/${findingId}`),
    );
    expect(detail.finding.state).toBe('rejected');

    // A rejected finding is terminal: it cannot be quietly revived.
    const revive = await h.request(`/api/v1/findings/${findingId}/review`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        expected_version: detail.finding.version,
        decision: 'confirm',
        reason: 'Trying to undo the rejection.',
        acknowledged_limitations: true,
      }),
    });
    expect(revive.status).toBe(409);
    expect((await h.json<{ code: string }>(revive)).code).toBe('INVALID_TRANSITION');
  });

  it('refuses to confirm a finding whose evidence has passed its retention date', async () => {
    const scan = await runScan();
    const findingId = scan.finding_ids[0]!;
    // The schema keeps expires_at after captured_at, so both move back together. This runs
    // on the migration connection because the runtime role deliberately cannot edit
    // captured_at — which is the point of the column grants.
    await withMigrationConnection(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', [
        'oe.tenant_id',
        LOCAL_FIXTURE.tenantA,
      ]);
      await client.query(
        `UPDATE oe.evidence
            SET captured_at = now() - interval '40 days',
                expires_at = now() - interval '10 days'
          WHERE scan_id = $1`,
        [scan.id],
      );
    });
    const response = await h.request(`/api/v1/findings/${findingId}/review`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        expected_version: 1,
        decision: 'confirm',
        reason: 'Confirming against expired artifacts.',
        acknowledged_limitations: true,
      }),
    });
    expect(response.status).toBe(422);
    expect((await h.json<{ code: string }>(response)).code).toBe('EVIDENCE_INCOMPLETE');
  });

  it('refuses to confirm while contrary evidence is recorded', async () => {
    const scan = await runScan();
    const findingId = scan.finding_ids[0]!;
    const sourceEvidence = await h.db.withTenant(LOCAL_FIXTURE.tenantA, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        "SELECT id FROM oe.evidence WHERE scan_id = $1 AND capture_role = 'source_page' LIMIT 1",
        [scan.id],
      );
      return rows.rows[0]!.id;
    });
    await h.db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
      tx.query(
        `INSERT INTO oe.finding_evidence (tenant_id, id, finding_id, evidence_id, relationship)
         VALUES (oe.tenant_context(), gen_random_uuid(), $1, $2, 'contradicts')`,
        [findingId, sourceEvidence],
      ),
    );
    const response = await h.request(`/api/v1/findings/${findingId}/review`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        expected_version: 1,
        decision: 'confirm',
        reason: 'Confirming despite a recorded contradiction.',
        acknowledged_limitations: true,
      }),
    });
    expect(response.status).toBe(422);
    expect((await h.json<{ detail: string }>(response)).detail).toMatch(/contrary evidence/i);
  });
});

describe('unconfigured providers fail closed', () => {
  it('refuses to admit a scan when live capture is not configured', async () => {
    const unconfigured = await createApiHarness({
      capture: new BrowserRunCaptureProvider({ endpoint: null, egressProofRecorded: false }),
    });
    try {
      const response = await unconfigured.request('/api/v1/scans', {
        method: 'POST',
        body: JSON.stringify(scanRequest()),
      });
      expect(response.status).toBe(503);
      const problem = await unconfigured.json<{ code: string; detail: string }>(response);
      expect(problem.code).toBe('PROVIDER_NOT_CONFIGURED');
      expect(problem.detail).toMatch(/No scan has been performed/i);
    } finally {
      await unconfigured.stop();
    }
  });

  it('reports the missing binding through readiness without contacting a provider', async () => {
    const unconfigured = await createApiHarness({
      capture: new BrowserRunCaptureProvider({ endpoint: null, egressProofRecorded: false }),
    });
    try {
      unconfigured.deps.config = {
        ...unconfigured.deps.config,
        capture: {
          ...unconfigured.deps.config.capture,
          adapter: 'browser_run',
          liveEnabled: false,
        },
      };
      const ready = await unconfigured.app.fetch(new Request('http://127.0.0.1:4173/api/ready'));
      expect(ready.status).toBe(503);
      const body = await unconfigured.json<{ status: string; missing_bindings: string[] }>(ready);
      expect(body.status).toBe('not_ready');
      expect(body.missing_bindings).toContain('LIVE_CAPTURE');
    } finally {
      await unconfigured.stop();
    }
  });

  it('never falls back from the live adapter to fixture data', async () => {
    const provider = new BrowserRunCaptureProvider({ endpoint: null, egressProofRecorded: false });
    const outcome = await provider.capture({
      url: 'https://shop.example.com/size-guide',
      approvedHosts: ['shop.example.com'],
      sessionId: 's',
      sessionOrdinal: 1,
      contextKey: 'c',
      role: 'link_destination',
      viewport: { width: 1280, height: 900 },
      locale: 'de-DE',
      operationKey: 'k',
      limits: {
        timeoutMs: 1000,
        maxBytes: 1000,
        maxHops: 3,
        imageTimeoutMs: 500,
        maxImages: 4,
        maxImageBytes: 1000,
      },
    });
    expect(outcome.status).not.toBe('captured');
  });
});

describe('deployment safety', () => {
  it('refuses to construct the fixture identity provider for a deployed origin', () => {
    expect(
      () =>
        new FixtureLocalIdentityProvider({
          environment: 'production',
          appOrigin: 'https://operator.example.com',
        }),
    ).toThrow(/refuses to start outside a local loopback environment/);
  });

  it('refuses to load a deployed configuration that enables fixture auth or fixture capture', () => {
    expect(() =>
      loadConfig({
        APP_ENV: 'production',
        APP_ORIGIN: 'https://operator.example.com',
        AUTH_MODE: 'fixture_local_only',
        DATABASE_URL: 'postgresql://x',
        LEDGER_CURRENCY: 'USD',
        CAPTURE_ADAPTER: 'local_fixture',
        FIXTURE_ORIGIN: 'http://127.0.0.1:4179',
        EVIDENCE_STORE: 'local_fs',
      }),
    ).toThrow(/rejected when APP_ENV=production/);
  });
});
