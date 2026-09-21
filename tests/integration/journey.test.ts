import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Evidence, Finding, Report, Scan, Session } from '@oe/contracts';
import { listBudgets } from '@oe/db';
import {
  createApiHarness,
  FIXTURE_SITE_ORIGIN,
  LOCAL_FIXTURE,
  scanRequest,
  stopFixtureSite,
  type ApiHarness,
} from '../support/api-harness.ts';

/**
 * The M1 journey, end to end through the real API, database, fixture capture and runner.
 *
 * IMPLEMENTATION_PLAN.md: "Operator signs in → membership resolved → approved account/URL
 * selected → explicit scan scope and cap → durable scan admission → safe collection in two
 * clean sessions → MF-LINK-01 candidate with actual evidence → human review → protected,
 * versioned report."
 *
 * Every observation here comes from the kit's synthetic loopback fixture. Nothing in this
 * file is evidence about a real merchant.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
}, 180_000);

afterAll(async () => {
  await h?.stop();
  stopFixtureSite();
});

async function admitScan(body: Record<string, unknown> = {}) {
  const response = await h.request('/api/v1/scans', {
    method: 'POST',
    subject: 'operator@fixture.test',
    body: JSON.stringify(scanRequest(body)),
  });
  return { response, scan: response.ok ? await h.json<Scan>(response) : null };
}

describe('session and membership', () => {
  it('rejects a request with no identity', async () => {
    const response = await h.request('/api/v1/session', { subject: '' });
    expect(response.status).toBe(401);
    const problem = await h.json<{ code: string }>(response);
    expect(problem.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a valid identity with no membership', async () => {
    const response = await h.request('/api/v1/session', { subject: 'stranger@fixture.test' });
    expect(response.status).toBe(403);
    expect((await h.json<{ code: string }>(response)).code).toBe('MEMBERSHIP_REQUIRED');
  });

  it('resolves the tenant and role from storage, not from the request', async () => {
    const response = await h.request('/api/v1/session', { subject: 'operator@fixture.test' });
    const session = await h.json<Session>(response);
    expect(session.active_tenant_id).toBe(LOCAL_FIXTURE.tenantA);
    expect(session.role).toBe('operator');
    expect(session.environment).toBe('local');
    expect(session.csrf_token.length).toBeGreaterThanOrEqual(20);
  });

  it('refuses an unsafe request without the session CSRF token', async () => {
    const response = await h.request('/api/v1/scans', {
      method: 'POST',
      csrf: false,
      body: JSON.stringify(scanRequest()),
    });
    expect(response.status).toBe(403);
    expect((await h.json<{ code: string }>(response)).code).toBe('CSRF_INVALID');
  });

  it('refuses an unsafe request from another origin', async () => {
    const response = await h.request('/api/v1/scans', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
      body: JSON.stringify(scanRequest()),
    });
    expect(response.status).toBe(403);
    expect((await h.json<{ code: string }>(response)).code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('refuses a scan from a viewer', async () => {
    const response = await h.request('/api/v1/scans', {
      method: 'POST',
      subject: 'viewer@fixture.test',
      body: JSON.stringify(scanRequest()),
    });
    expect(response.status).toBe(403);
    expect((await h.json<{ code: string }>(response)).code).toBe('ROLE_REQUIRED');
  });

  it('refuses account creation from an operator', async () => {
    const response = await h.request('/api/v1/accounts', {
      method: 'POST',
      subject: 'operator@fixture.test',
      body: JSON.stringify({
        name: 'New',
        canonical_domain: 'new.test',
        venture_id: LOCAL_FIXTURE.ventureA,
        approved_hosts: ['new.test'],
        source_note: 'note',
      }),
    });
    expect(response.status).toBe(403);
  });
});

describe('admission safety', () => {
  it('refuses a host the account has not approved', async () => {
    const { response } = await admitScan({
      target_url: 'https://not-approved.example.com/product',
    });
    expect(response.status).toBe(422);
    expect((await h.json<{ code: string }>(response)).code).toBe('TARGET_NOT_APPROVED');
  });

  it('refuses a path that could change store state', async () => {
    const { response } = await admitScan({ target_url: `${FIXTURE_SITE_ORIGIN}/cart/add` });
    expect(response.status).toBe(422);
    expect((await h.json<{ code: string }>(response)).code).toBe('UNSAFE_TARGET');
  });

  it('refuses a URL carrying a token-like query parameter', async () => {
    const { response } = await admitScan({
      target_url: `${FIXTURE_SITE_ORIGIN}/product?token=abc`,
    });
    expect(response.status).toBe(422);
  });

  it('refuses a detector that is specified but not implemented', async () => {
    // contracts/detectors.json specifies six detectors; this build implements two.
    const { response } = await admitScan({ detectors: ['PDP-VISUAL-01'] });
    expect(response.status).toBe(422);
    expect((await h.json<{ code: string }>(response)).code).toBe('INVALID_REQUEST');
  });

  it('refuses a currency the workspace does not account in', async () => {
    const { response } = await admitScan({ max_cost: { currency: 'EUR', amount_micro: '100000' } });
    expect(response.status).toBe(422);
    expect((await h.json<{ code: string }>(response)).code).toBe('CURRENCY_MISMATCH');
  });

  it('refuses another tenant’s account with the same not-found shape', async () => {
    const { response } = await admitScan({ account_id: LOCAL_FIXTURE.accountB });
    expect(response.status).toBe(404);
    const problem = await h.json<{ detail: string }>(response);
    // No hint that the id exists elsewhere.
    expect(problem.detail).not.toContain('modewerk');
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    const response = await h.request('/api/v1/scans', {
      method: 'POST',
      body: JSON.stringify({ ...scanRequest(), tenant_id: LOCAL_FIXTURE.tenantB }),
    });
    expect(response.status).toBe(422);
  });

  it('requires an Idempotency-Key', async () => {
    const response = await h.request('/api/v1/scans', {
      method: 'POST',
      headers: { 'idempotency-key': 'short' },
      body: JSON.stringify(scanRequest()),
    });
    expect(response.status).toBe(422);
  });
});

describe('the complete journey', () => {
  let scanId: string;
  let findingId: string;
  let reportId: string;

  it('admits a bounded scan and returns 202 only after the transaction commits', async () => {
    const { response, scan } = await admitScan();
    expect(response.status).toBe(202);
    expect(scan!.state).toBe('queued');
    expect(scan!.coverage.expected_unique_pages).toBe(2);
    expect(scan!.coverage.captured_unique_pages).toBe(0);
    expect(scan!.cost.cap).toEqual({ currency: 'USD', amount_micro: '100000' });
    scanId = scan!.id;

    // The scan row and its outbox event share one transaction.
    const outbox = await h.db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
      tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM oe.outbox WHERE aggregate_id = $1 AND event_type = 'scan.admitted'",
        [scanId],
      ),
    );
    expect(outbox.rows[0]!.n).toBe(1);
  });

  it('reserves the worst-case cost against every scope at admission', async () => {
    const budgets = await h.db.withTenant(LOCAL_FIXTURE.tenantA, (tx) => listBudgets(tx));
    const scanBudget = budgets.find((b) => b.scope_kind === 'scan' && b.scope_id === scanId);
    expect(scanBudget).toBeDefined();
    expect(scanBudget!.limit_micro).toBe('100000');
    // The fixture transport makes no paid call, so the reservation is zero — but it exists.
    const reservations = await h.db.withTenant(LOCAL_FIXTURE.tenantA, (tx) =>
      tx.query<{ n: number; state: string }>(
        'SELECT count(*)::int AS n, min(state) AS state FROM oe.reservations WHERE scan_id = $1',
        [scanId],
      ),
    );
    expect(reservations.rows[0]!.n).toBe(1);
    expect(reservations.rows[0]!.state).toBe('reserved');
  });

  it('returns the original response for a repeated Idempotency-Key', async () => {
    const key = 'journey-idempotency-key-1';
    const body = JSON.stringify(scanRequest({ max_unique_pages: 3 }));
    const first = await h.request('/api/v1/scans', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body,
    });
    const second = await h.request('/api/v1/scans', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body,
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const a = await h.json<Scan>(first);
    const b = await h.json<Scan>(second);
    expect(b.id).toBe(a.id);

    // Reusing the key with different input is a conflict, never a second scan.
    const altered = await h.request('/api/v1/scans', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify(scanRequest({ max_unique_pages: 4 })),
    });
    expect(altered.status).toBe(409);
    expect((await h.json<{ code: string }>(altered)).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('runs the scan, captures two clean sessions of each page and records real evidence', async () => {
    await h.drain();
    const response = await h.request(`/api/v1/scans/${scanId}`);
    const scan = await h.json<Scan>(response);
    expect(scan.state).toBe('succeeded');
    expect(scan.coverage.captured_unique_pages).toBe(2);
    expect(scan.evidence_ids.length).toBeGreaterThanOrEqual(4);

    const timeline = await h.json<{
      evidence: Evidence[];
      steps: { step_key: string; state: string }[];
    }>(await h.request(`/api/v1/scans/${scanId}/timeline`));
    const destination = timeline.evidence.filter((e) => e.source_url.includes('/size-guide'));
    expect(destination).toHaveLength(2);
    // Two independent sessions, not one request recorded twice.
    expect(new Set(destination.map((e) => e.conditions.session_id)).size).toBe(2);
    for (const evidence of destination) {
      expect(evidence.http_status).toBe(404);
      expect(evidence.complete).toBe(true);
      expect(evidence.conditions.viewport_width).toBe(1280);
      expect(evidence.conditions.locale).toBe('de-DE');
      expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(timeline.steps.map((s) => s.step_key)).toContain('detect:MF-LINK-01');
  });

  it('produces a candidate finding that is not yet a customer-facing claim', async () => {
    const scan = await h.json<Scan>(await h.request(`/api/v1/scans/${scanId}`));
    expect(scan.finding_ids).toHaveLength(1);
    findingId = scan.finding_ids[0]!;

    const detail = await h.json<{ finding: Finding; evidence: Evidence[] }>(
      await h.request(`/api/v1/findings/${findingId}`),
    );
    expect(detail.finding.state).toBe('candidate');
    expect(detail.finding.detector_id).toBe('MF-LINK-01');
    expect(detail.finding.evidence_grade).toBe('A');
    expect(detail.finding.reviewer_id).toBeNull();
    expect(detail.finding.commercial_impact).toBe('hypothesis');
    expect(detail.finding.claim).toContain('404');
    expect(detail.finding.limitations.join(' ')).toMatch(/revenue impact are unknown/i);
    expect(detail.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it('serves the captured screenshot only through the tenant-scoped route', async () => {
    const detail = await h.json<{ evidence: Evidence[] }>(
      await h.request(`/api/v1/findings/${findingId}`),
    );
    const withArtifact = detail.evidence.find((e) => e.content_available);
    expect(withArtifact, 'the fixture capture produced no artifact').toBeDefined();

    const content = await h.request(`/api/v1/evidence/${withArtifact!.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('content-security-policy')).toContain('sandbox');
    const bytes = new Uint8Array(await content.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // PNG magic number: this is a real rendered image, not a placeholder.
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('refuses a review from an operator and a confirmation on a stale version', async () => {
    const asOperator = await h.request(`/api/v1/findings/${findingId}/review`, {
      method: 'POST',
      subject: 'operator@fixture.test',
      body: JSON.stringify({
        expected_version: 1,
        decision: 'confirm',
        reason: 'Looks fine to me.',
        acknowledged_limitations: true,
      }),
    });
    expect(asOperator.status).toBe(403);

    const stale = await h.request(`/api/v1/findings/${findingId}/review`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        expected_version: 99,
        decision: 'confirm',
        reason: 'Reviewed the recorded captures.',
        acknowledged_limitations: true,
      }),
    });
    expect(stale.status).toBe(409);
    expect((await h.json<{ code: string }>(stale)).code).toBe('STALE_REVIEW');
  });

  it('confirms the finding, binding the reviewer to that exact version', async () => {
    const response = await h.request(`/api/v1/findings/${findingId}/review`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        expected_version: 1,
        decision: 'confirm',
        reason: 'Both recorded checks returned 404 for the linked size guide.',
        acknowledged_limitations: true,
      }),
    });
    expect(response.status).toBe(200);
    const finding = await h.json<Finding>(response);
    expect(finding.state).toBe('confirmed');
    expect(finding.version).toBe(2);
    expect(finding.reviewer_id).not.toBeNull();
    expect(finding.reviewed_at).not.toBeNull();

    const reviews = await h.json<{ items: { decision: string; finding_version: number }[] }>(
      await h.request(`/api/v1/findings/${findingId}/reviews`),
    );
    expect(reviews.items[0]).toMatchObject({ decision: 'confirm', finding_version: 1 });
  });

  it('rejects a second decision on the version that was already reviewed', async () => {
    const response = await h.request(`/api/v1/findings/${findingId}/review`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        expected_version: 1,
        decision: 'reject',
        reason: 'Changing my mind about version one.',
        acknowledged_limitations: true,
      }),
    });
    expect(response.status).toBe(409);
  });

  it('builds a report bound to the reviewed finding version', async () => {
    const response = await h.request('/api/v1/reports', {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        account_id: LOCAL_FIXTURE.accountA,
        scan_id: scanId,
        finding_versions: [{ finding_id: findingId, version: 2 }],
        language: 'en',
        scope_summary: 'We inspected this page and its linked size guide.',
      }),
    });
    expect(response.status).toBe(201);
    const report = await h.json<Report>(response);
    reportId = report.id;
    expect(report.state).toBe('draft');
    expect(report.audience).toBe('internal_tenant');
    expect(report.finding_versions).toEqual([{ finding_id: findingId, version: 2 }]);
    expect(report.limitations.join(' ')).toMatch(/has not been measured/i);
  });

  it('refuses to build a report from a version that is not the current one', async () => {
    const response = await h.request('/api/v1/reports', {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        account_id: LOCAL_FIXTURE.accountA,
        scan_id: scanId,
        finding_versions: [{ finding_id: findingId, version: 1 }],
        language: 'en',
        scope_summary: 'Stale binding.',
      }),
    });
    expect(response.status).toBe(409);
    expect((await h.json<{ code: string }>(response)).code).toBe('STALE_REVIEW');
  });

  it('refuses to publish a draft directly, then approves and publishes it', async () => {
    const skipped = await h.request(`/api/v1/reports/${reportId}/publish`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({ expected_version: 1 }),
    });
    expect(skipped.status).toBe(409);
    expect((await h.json<{ code: string }>(skipped)).code).toBe('INVALID_TRANSITION');

    const approved = await h.json<Report>(
      await h.request(`/api/v1/reports/${reportId}/approve`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({ expected_version: 1 }),
      }),
    );
    expect(approved.state).toBe('approved');
    expect(approved.approved_at).not.toBeNull();

    const published = await h.json<Report>(
      await h.request(`/api/v1/reports/${reportId}/publish`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({ expected_version: 2 }),
      }),
    );
    expect(published.state).toBe('published');
    expect(published.published_at).not.toBeNull();
  });

  it('serves an immutable, hash-bound report body with its scope and limits', async () => {
    const payload = await h.json<Report & { body: Record<string, unknown>; body_sha256: string }>(
      await h.request(`/api/v1/reports/${reportId}`),
    );
    expect(payload.body_sha256).toMatch(/^[a-f0-9]{64}$/);
    const body = payload.body as {
      confirmed_findings: { claim: string; observed_conditions: unknown[] }[];
      no_supported_defect: boolean;
      inspected: { captured_unique_pages: number };
      exclusions: string[];
    };
    expect(body.no_supported_defect).toBe(false);
    expect(body.confirmed_findings).toHaveLength(1);
    expect(body.confirmed_findings[0]!.observed_conditions).toHaveLength(2);
    expect(body.inspected.captured_unique_pages).toBe(2);
    expect(body.exclusions.join(' ')).toMatch(/not a guarantee/i);
    // No invented revenue anywhere in the rendered body.
    expect(JSON.stringify(body)).not.toMatch(/€\s?\d|revenue (uplift|increase)|lost sales/i);
  });

  it('withholds the body of a revoked report without leaking customer data', async () => {
    const revoked = await h.json<Report>(
      await h.request(`/api/v1/reports/${reportId}/revoke`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({ expected_version: 3 }),
      }),
    );
    expect(revoked.state).toBe('revoked');

    const payload = await h.json<{ body: unknown; scope_summary: string }>(
      await h.request(`/api/v1/reports/${reportId}`),
    );
    expect(payload.body).toBeNull();
  });

  it('shows the opportunity with an interval score, not a false point estimate', async () => {
    const list = await h.json<{
      items: {
        id: string;
        priority: { pointScore: number | null; unknown: string[] } | null;
        next_action: string;
      }[];
    }>(await h.request('/api/v1/opportunities'));
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    const opportunity = list.items[0]!;
    expect(opportunity.priority!.pointScore).toBeNull();
    expect(opportunity.priority!.unknown).toEqual(expect.arrayContaining(['timing', 'value']));
    expect(opportunity.next_action).toBe('review_evidence');
  });
});

describe('cross-tenant access through the API', () => {
  it('returns 404 for another tenant’s scan, finding, evidence and report', async () => {
    const otherScanId = await h.db.withTenant(LOCAL_FIXTURE.tenantB, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO oe.scans (tenant_id, id, account_id, venture_id, authorization_id, target_url,
           state, version, expected_unique_pages, requested_by)
         VALUES (oe.tenant_context(), gen_random_uuid(), $1, $2, $3, 'https://modewerk.test/p',
           'queued', 1, 2, $4) RETURNING id`,
        [
          LOCAL_FIXTURE.accountB,
          LOCAL_FIXTURE.ventureB,
          LOCAL_FIXTURE.authorizationB,
          LOCAL_FIXTURE.ownerB,
        ],
      );
      return result.rows[0]!.id;
    });

    for (const path of [
      `/api/v1/scans/${otherScanId}`,
      `/api/v1/scans/${otherScanId}/timeline`,
      `/api/v1/findings/${otherScanId}`,
      `/api/v1/evidence/${otherScanId}`,
      `/api/v1/reports/${otherScanId}`,
    ]) {
      const response = await h.request(path, { subject: 'operator@fixture.test' });
      expect(response.status, path).toBe(404);
    }
  });

  it('never lists another tenant’s accounts or scans', async () => {
    const accounts = await h.json<{ items: { id: string }[] }>(await h.request('/api/v1/accounts'));
    expect(accounts.items.map((a) => a.id)).not.toContain(LOCAL_FIXTURE.accountB);
    const scans = await h.json<{ items: { account_id: string }[] }>(
      await h.request('/api/v1/scans'),
    );
    expect(scans.items.every((s) => s.account_id === LOCAL_FIXTURE.accountA)).toBe(true);
  });
});
