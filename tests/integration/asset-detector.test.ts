import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Evidence, Finding, Report, Scan } from '@oe/contracts';
import {
  createApiHarness,
  LOCAL_FIXTURE,
  M2_FIXTURE_SITE_ORIGIN,
  scanRequest,
  stopFixtureSite,
  type ApiHarness,
} from '../support/api-harness.ts';

/**
 * MF-ASSET-01 end to end: real API, real database, real image requests, real Chromium render.
 *
 * Each route in `fixtures/m2-server.mjs` is a control for one branch of the rule. Together they
 * are the held-out set M2's gate asks for — a known positive, a healthy negative, and one case
 * per declared abstention.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
}, 180_000);

afterAll(async () => {
  await h?.stop();
  stopFixtureSite();
});

interface Timeline {
  steps: { step_key: string; state: string }[];
  evidence: Evidence[];
  findings: Finding[];
}

async function runAssetScan(route: string): Promise<{ scan: Scan; timeline: Timeline }> {
  const response = await h.request('/api/v1/scans', {
    method: 'POST',
    body: JSON.stringify(
      scanRequest({
        target_url: `${M2_FIXTURE_SITE_ORIGIN}/${route}`,
        max_unique_pages: 1,
        detectors: ['MF-ASSET-01'],
      }),
    ),
  });
  expect(response.status, await response.clone().text()).toBe(202);
  const admitted = await h.json<Scan>(response);
  await h.drain();
  const scan = await h.json<Scan>(await h.request(`/api/v1/scans/${admitted.id}`));
  const timeline = await h.json<Timeline>(await h.request(`/api/v1/scans/${admitted.id}/timeline`));
  return { scan, timeline };
}

const assetFindings = (timeline: Timeline) =>
  timeline.findings.filter((finding) => finding.detector_id === 'MF-ASSET-01');

describe('known positive', () => {
  it('records a candidate for a product image that 404s and does not paint', async () => {
    const { scan, timeline } = await runAssetScan('product-broken-image');
    expect(scan.state).toBe('succeeded');

    const findings = assetFindings(timeline);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.state).toBe('candidate');
    expect(finding.evidence_grade).toBe('A');
    expect(finding.reviewer_id).toBeNull();
    expect(finding.claim).toMatch(/did not load in 2 recorded checks/);
    expect(finding.claim).toContain('HTTP 404');
    expect(finding.detector_version).toBe('2.0.0');
    expect(finding.limitations.join(' ')).toMatch(/revenue impact are unknown/i);

    // Two independent observations of the same image, both cited.
    expect(finding.evidence_ids).toHaveLength(2);
    const cited = timeline.evidence.filter((item) => finding.evidence_ids.includes(item.id));
    expect(cited).toHaveLength(2);
    expect(new Set(cited.map((item) => item.conditions.session_id)).size).toBe(2);
    for (const item of cited) {
      expect(item.source_url).toContain('missing.png');
      expect(item.http_status).toBe(404);
    }
  });

  it('records a candidate for a 200 response that carried no image', async () => {
    const { timeline } = await runAssetScan('product-empty-image');
    const findings = assetFindings(timeline);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.claim).toContain('empty body');
    expect(findings[0]!.state).toBe('candidate');
  });

  it('stores every image as its own citeable observation, page and all', async () => {
    const { scan, timeline } = await runAssetScan('product-broken-image');
    const images = timeline.evidence.filter((item) => item.source_url.endsWith('.png'));
    // Two images, two clean sessions.
    expect(images).toHaveLength(4);
    // Images are subresources: they never inflate the page denominator.
    expect(scan.coverage.expected_unique_pages).toBe(1);
    expect(scan.coverage.captured_unique_pages).toBe(1);
    expect(scan.coverage.reasons.join(' ')).toMatch(/Images are part of the page, not extra pages/);

    const working = images.filter((item) => item.http_status === 200);
    expect(working).toHaveLength(2);
    // A recorded image that did load keeps its bytes, so a reviewer can see it.
    expect(working.every((item) => item.content_available)).toBe(true);

    const content = await h.request(`/api/v1/evidence/${working[0]!.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await content.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('negative controls', () => {
  it('reports no finding when every product image loads', async () => {
    const { scan, timeline } = await runAssetScan('product-healthy');
    expect(scan.state).toBe('succeeded');
    expect(assetFindings(timeline)).toHaveLength(0);
    // The images were still recorded: "no finding" is a result, not an absence of work.
    expect(timeline.evidence.filter((item) => item.source_url.endsWith('.png'))).toHaveLength(4);
  });

  it('abstains on an image still loading when the bounded wait expires', async () => {
    const { scan, timeline } = await runAssetScan('product-lazy');
    expect(assetFindings(timeline)).toHaveLength(0);
    expect(scan.coverage.reasons.join(' ')).toMatch(/still loading when the bounded wait expired/i);
    // A slow image is never described as broken.
    expect(scan.coverage.reasons.join(' ')).not.toMatch(/did not load|broken|404/i);
  });

  it('ignores a decorative image that fails while the product images load', async () => {
    const { timeline } = await runAssetScan('product-decorative-broken');
    expect(assetFindings(timeline)).toHaveLength(0);

    // The failing decorative image is still recorded, just not claimed.
    const failed = timeline.evidence.filter(
      (item) => item.source_url.includes('missing.png') && item.http_status === 404,
    );
    expect(failed.length).toBeGreaterThan(0);
  });

  it('abstains when the page serves a different product state between checks', async () => {
    const { scan, timeline } = await runAssetScan('product-variant');
    expect(assetFindings(timeline)).toHaveLength(0);
    expect(scan.coverage.reasons.join(' ')).toMatch(/different product state between checks/i);
  });
});

describe('admission', () => {
  it('refuses a detector that is specified but not implemented', async () => {
    const response = await h.request('/api/v1/scans', {
      method: 'POST',
      body: JSON.stringify(scanRequest({ detectors: ['PDP-VISUAL-01'] })),
    });
    expect(response.status).toBe(422);
  });

  it('accepts both implemented detectors on one scan', async () => {
    const response = await h.request('/api/v1/scans', {
      method: 'POST',
      body: JSON.stringify(
        scanRequest({
          target_url: `${M2_FIXTURE_SITE_ORIGIN}/product-broken-image`,
          max_unique_pages: 2,
          detectors: ['MF-LINK-01', 'MF-ASSET-01'],
        }),
      ),
    });
    expect(response.status).toBe(202);
    const admitted = await h.json<Scan>(response);
    await h.drain();
    const timeline = await h.json<Timeline>(
      await h.request(`/api/v1/scans/${admitted.id}/timeline`),
    );
    // Both detectors ran; only the asset rule had something to say about this page.
    expect(timeline.steps.map((step) => step.step_key)).toEqual(
      expect.arrayContaining(['detect:MF-LINK-01', 'detect:MF-ASSET-01']),
    );
    expect(assetFindings(timeline)).toHaveLength(1);
  });

  it('runs only the detector a scan was admitted with', async () => {
    const { timeline } = await runAssetScan('product-broken-image');
    expect(timeline.steps.map((step) => step.step_key)).toContain('detect:MF-ASSET-01');
    expect(timeline.steps.map((step) => step.step_key)).not.toContain('detect:MF-LINK-01');
    expect(timeline.findings.every((finding) => finding.detector_id === 'MF-ASSET-01')).toBe(true);
  });
});

describe('review and report', () => {
  it('carries a confirmed image finding into a report bound to its version', async () => {
    const { scan, timeline } = await runAssetScan('product-broken-image');
    const finding = assetFindings(timeline)[0]!;

    const confirmed = await h.json<Finding>(
      await h.request(`/api/v1/findings/${finding.id}/review`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({
          expected_version: finding.version,
          decision: 'confirm',
          reason: 'Both recorded checks returned 404 for the product image and it did not render.',
          acknowledged_limitations: true,
        }),
      }),
    );
    expect(confirmed.state).toBe('confirmed');

    const created = await h.request('/api/v1/reports', {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        account_id: LOCAL_FIXTURE.accountA,
        scan_id: scan.id,
        finding_versions: [{ finding_id: finding.id, version: confirmed.version }],
        language: 'en',
        scope_summary: 'We inspected this product page and the images it references.',
      }),
    });
    expect(created.status).toBe(201);
    const report = await h.json<Report>(created);

    const payload = await h.json<{
      body: {
        confirmed_findings: {
          claim: string;
          detector_id: string;
          observed_conditions: unknown[];
        }[];
      };
    }>(await h.request(`/api/v1/reports/${report.id}`));
    expect(payload.body.confirmed_findings).toHaveLength(1);
    expect(payload.body.confirmed_findings[0]!.detector_id).toBe('MF-ASSET-01');
    expect(payload.body.confirmed_findings[0]!.observed_conditions).toHaveLength(2);
    // No invented commercial effect anywhere in the rendered body.
    expect(JSON.stringify(payload.body)).not.toMatch(
      /€\s?\d|revenue (uplift|increase)|lost sales/i,
    );
  });

  it('groups repeated failures of the same asset into one opportunity', async () => {
    const first = await runAssetScan('product-broken-image');
    const second = await runAssetScan('product-broken-image');
    const firstFinding = assetFindings(first.timeline)[0]!;
    const secondFinding = assetFindings(second.timeline)[0]!;
    expect(firstFinding.root_cause_key).toBe(secondFinding.root_cause_key);
    expect(firstFinding.root_cause_key).toMatch(/^product-image:/);

    const list = await h.json<{ items: { id: string; finding_ids: string[] }[] }>(
      await h.request('/api/v1/opportunities?limit=100'),
    );
    const holding = list.items.filter(
      (item) =>
        item.finding_ids.includes(firstFinding.id) || item.finding_ids.includes(secondFinding.id),
    );
    // One root cause, one opportunity — not a new pitch per scan.
    expect(holding).toHaveLength(1);
    expect(holding[0]!.finding_ids).toEqual(
      expect.arrayContaining([firstFinding.id, secondFinding.id]),
    );
  });
});

describe('subresource policy', () => {
  it('never requests an image outside the account’s approved hosts', async () => {
    const { timeline } = await runAssetScan('product-broken-image');
    const account = await h.json<{ items: { id: string; approved_hosts: string[] }[] }>(
      await h.request('/api/v1/accounts'),
    );
    const approved = account.items.find(
      (item) => item.id === LOCAL_FIXTURE.accountA,
    )!.approved_hosts;
    for (const item of timeline.evidence) {
      expect(approved).toContain(new URL(item.source_url).host);
    }
  });
});
