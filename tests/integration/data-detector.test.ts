import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Evidence, Finding, Scan } from '@oe/contracts';
import {
  createApiHarness,
  M2_FIXTURE_SITE_ORIGIN,
  scanRequest,
  stopFixtureSite,
  type ApiHarness,
} from '../support/api-harness.ts';

/**
 * CE-DATA-01 end to end: real API, real database, real HTTP, real parsing.
 *
 * Each route in `fixtures/m2-server.mjs` is a control for one branch of the rule — the known
 * positive, the healthy negative, and one per abstention the contract declares. Together they
 * are the held-out set M2's gate asks for.
 *
 * The asymmetry worth stating: a false positive here tells a shop their store contradicts
 * itself when it does not, so most of this file asserts that the rule stayed quiet.
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

async function runDataScan(route: string): Promise<{ scan: Scan; timeline: Timeline }> {
  const response = await h.request('/api/v1/scans', {
    method: 'POST',
    body: JSON.stringify(
      scanRequest({
        target_url: `${M2_FIXTURE_SITE_ORIGIN}/${route}`,
        max_unique_pages: 1,
        detectors: ['CE-DATA-01'],
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

const dataFindings = (timeline: Timeline) =>
  timeline.findings.filter((finding) => finding.detector_id === 'CE-DATA-01');

describe('the known positive', () => {
  it('records a candidate when the page and its markup state different prices', async () => {
    const { scan, timeline } = await runDataScan('product-price-mismatch');
    expect(timeline.steps.map((s) => s.step_key)).toContain('detect:CE-DATA-01');

    const findings = dataFindings(timeline);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;

    expect(finding.state).toBe('candidate');
    expect(finding.evidence_grade).toBe('A');
    expect(finding.claim).toContain('89.00 EUR');
    expect(finding.claim).toContain('49.00 EUR');
    // Two independent sessions, both cited.
    expect(finding.evidence_ids).toHaveLength(2);
    expect(scan.state).toBe('succeeded');
  });

  it('tells a reviewer it does not know which figure is right', async () => {
    const { timeline } = await runDataScan('product-price-mismatch');
    const finding = dataFindings(timeline)[0]!;
    expect(finding.limitations.join(' ')).toContain('does not establish which one is correct');
    expect(finding.commercial_impact).toBe('hypothesis');
  });

  it('records a stock contradiction as its own claim', async () => {
    const { timeline } = await runDataScan('product-stock-mismatch');
    const findings = dataFindings(timeline);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.claim).toContain('availability');
    expect(findings[0]!.claim).toContain('out_of_stock');
  });
});

describe('the negative controls', () => {
  it('reports no finding when the two statements agree', async () => {
    const { scan, timeline } = await runDataScan('product-data-healthy');
    expect(dataFindings(timeline)).toEqual([]);
    expect(scan.state).toBe('succeeded');
    expect(scan.coverage.reasons.join(' ')).toContain('stated the same facts');
  });

  it('abstains on an aggregate offer, and says so', async () => {
    const { scan, timeline } = await runDataScan('product-aggregate-offer');
    expect(dataFindings(timeline)).toEqual([]);
    expect(scan.coverage.reasons.join(' ')).toContain('price range across variants');
  });

  it('abstains when a tax basis difference could explain the gap', async () => {
    // 74.79 net against 89.00 gross is exactly 19% German VAT: the commonest legal
    // arrangement in Europe, and the one a careless rule would report as a defect.
    const { timeline, scan } = await runDataScan('product-tax-basis');
    expect(dataFindings(timeline)).toEqual([]);
    expect(scan.coverage.reasons.join(' ')).toContain('tax basis difference could explain');
  });

  it('abstains when two currencies are in view', async () => {
    const { timeline, scan } = await runDataScan('product-multi-currency');
    // The prices genuinely differ on this fixture. The rule still refuses, because with two
    // currencies on screen a difference between figures is ambiguous rather than wrong.
    expect(dataFindings(timeline)).toEqual([]);
    expect(scan.coverage.reasons.join(' ')).toContain('More than one currency');
  });

  it('abstains on a page carrying no structured data at all', async () => {
    const { timeline, scan } = await runDataScan('product-no-markup');
    expect(dataFindings(timeline)).toEqual([]);
    expect(scan.coverage.reasons.join(' ')).toContain('no structured product data');
  });

  it('abstains when the two captures saw different product states', async () => {
    // The variant fixture serves a different selected size on alternate requests, so the two
    // clean sessions are not comparable — whatever their markup says.
    const { timeline, scan } = await runDataScan('product-variant');
    expect(dataFindings(timeline)).toEqual([]);
    // The rule ran and answered; it just could not compare. A reader must be able to tell
    // that from "we did not look", which is what the reason is for.
    expect(scan.coverage.reasons.join(' ')).toContain('different product state between checks');
  });
});

describe('admission', () => {
  it('accepts all three implemented detectors on one scan', async () => {
    const response = await h.request('/api/v1/scans', {
      method: 'POST',
      body: JSON.stringify(
        scanRequest({
          target_url: `${M2_FIXTURE_SITE_ORIGIN}/product-price-mismatch`,
          max_unique_pages: 1,
          detectors: ['CE-LINK-01', 'CE-ASSET-01', 'CE-DATA-01'],
        }),
      ),
    });
    expect(response.status, await response.clone().text()).toBe(202);
    const admitted = await h.json<Scan>(response);
    await h.drain();
    const timeline = await h.json<Timeline>(
      await h.request(`/api/v1/scans/${admitted.id}/timeline`),
    );
    expect(timeline.steps.map((s) => s.step_key)).toEqual(
      expect.arrayContaining(['detect:CE-LINK-01', 'detect:CE-ASSET-01', 'detect:CE-DATA-01']),
    );
  });

  it('accepts the handoff spelling and records the engine one', async () => {
    const response = await h.request('/api/v1/scans', {
      method: 'POST',
      body: JSON.stringify(
        scanRequest({
          target_url: `${M2_FIXTURE_SITE_ORIGIN}/product-price-mismatch`,
          max_unique_pages: 1,
          detectors: ['MF-DATA-01'],
        }),
      ),
    });
    expect(response.status, await response.clone().text()).toBe(202);
    const admitted = await h.json<Scan>(response);
    await h.drain();
    const timeline = await h.json<Timeline>(
      await h.request(`/api/v1/scans/${admitted.id}/timeline`),
    );
    // Sent as MF-, recorded as CE-. The mapping holds all the way through the runner.
    expect(timeline.steps.map((s) => s.step_key)).toContain('detect:CE-DATA-01');
    expect(dataFindings(timeline)[0]?.detector_id).toBe('CE-DATA-01');
  });

  it('still refuses a detector this build has not implemented', async () => {
    const response = await h.request('/api/v1/scans', {
      method: 'POST',
      body: JSON.stringify(
        scanRequest({
          target_url: `${M2_FIXTURE_SITE_ORIGIN}/product-data-healthy`,
          max_unique_pages: 1,
          detectors: ['CE-VISUAL-01'],
        }),
      ),
    });
    expect(response.status).toBe(422);
  });

  it('runs only the detector a scan was admitted with', async () => {
    const { timeline } = await runDataScan('product-price-mismatch');
    const keys = timeline.steps.map((s) => s.step_key);
    expect(keys).toContain('detect:CE-DATA-01');
    expect(keys).not.toContain('detect:CE-ASSET-01');
    expect(keys).not.toContain('detect:CE-LINK-01');
  });
});
