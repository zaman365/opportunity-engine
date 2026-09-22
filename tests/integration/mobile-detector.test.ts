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
 * CE-MOBILE-01 end to end: real API, real database, real Chromium layout.
 *
 * The measurement is the part that cannot be unit-tested — whether a `position:fixed` bar in
 * the markup actually covers a third of a 390-pixel screen is a question for a browser, not a
 * parser. These cases run it.
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

async function runMobileScan(route: string): Promise<{ scan: Scan; timeline: Timeline }> {
  const response = await h.request('/api/v1/scans', {
    method: 'POST',
    body: JSON.stringify(
      scanRequest({
        target_url: `${M2_FIXTURE_SITE_ORIGIN}/${route}`,
        max_unique_pages: 1,
        detectors: ['CE-MOBILE-01'],
      }),
    ),
  });
  expect(response.status, await response.clone().text()).toBe(202);
  const admitted = await h.json<Scan>(response);
  await h.drain();
  return {
    scan: await h.json<Scan>(await h.request(`/api/v1/scans/${admitted.id}`)),
    timeline: await h.json<Timeline>(await h.request(`/api/v1/scans/${admitted.id}/timeline`)),
  };
}

const mobileFindings = (timeline: Timeline) =>
  timeline.findings.filter((finding) => finding.detector_id === 'CE-MOBILE-01');

describe('the known positive', () => {
  it('records a candidate for a bar that covers a third of a phone screen', async () => {
    const { scan, timeline } = await runMobileScan('product-mobile-blocked');
    expect(timeline.steps.map((s) => s.step_key)).toContain('detect:CE-MOBILE-01');

    const findings = mobileFindings(timeline);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.state).toBe('candidate');
    expect(finding.evidence_grade).toBe('A');
    expect(finding.claim).toContain('390×844');
    expect(finding.claim).toContain('fixed');
    expect(finding.evidence_ids).toHaveLength(2);
    expect(scan.state).toBe('succeeded');
  });

  it('captures the phone view as its own evidence, at its own viewport', async () => {
    const { timeline } = await runMobileScan('product-mobile-blocked');
    const phone = timeline.evidence.filter((e) => e.conditions.viewport_width === 390);
    // Two independent phone sessions, recorded as themselves rather than reinterpreted from
    // the desktop ones.
    expect(phone.length).toBeGreaterThanOrEqual(2);
    expect(new Set(phone.map((e) => e.conditions.session_id)).size).toBeGreaterThanOrEqual(2);
  });

  it('does not count the phone view as another page', async () => {
    // The same page at a second viewport is one page seen twice, not two pages.
    const { scan } = await runMobileScan('product-mobile-blocked');
    expect(scan.coverage.expected_unique_pages).toBe(1);
    expect(scan.coverage.captured_unique_pages).toBe(1);
  });
});

describe('the negative controls', () => {
  it('says nothing about a conventional 48-pixel sticky header', async () => {
    const { scan, timeline } = await runMobileScan('product-mobile-normal');
    expect(mobileFindings(timeline)).toEqual([]);
    expect(scan.coverage.reasons.join(' ')).toContain('Nothing covered the page');
  });

  it('abstains when the cover carries a close button', async () => {
    const { scan, timeline } = await runMobileScan('product-mobile-dismissible');
    expect(mobileFindings(timeline)).toEqual([]);
    expect(scan.coverage.reasons.join(' ')).toContain('visible way to close it');
  });

  it('abstains on a loading state', async () => {
    const { scan, timeline } = await runMobileScan('product-mobile-loading');
    expect(mobileFindings(timeline)).toEqual([]);
    expect(scan.coverage.reasons.join(' ')).toContain('loading state');
  });
});

describe('admission', () => {
  it('accepts the handoff spelling and records the engine one', async () => {
    const response = await h.request('/api/v1/scans', {
      method: 'POST',
      body: JSON.stringify(
        scanRequest({
          target_url: `${M2_FIXTURE_SITE_ORIGIN}/product-mobile-blocked`,
          max_unique_pages: 1,
          detectors: ['PDP-MOBILE-01'],
        }),
      ),
    });
    expect(response.status, await response.clone().text()).toBe(202);
    const admitted = await h.json<Scan>(response);
    await h.drain();
    const timeline = await h.json<Timeline>(
      await h.request(`/api/v1/scans/${admitted.id}/timeline`),
    );
    expect(timeline.steps.map((s) => s.step_key)).toContain('detect:CE-MOBILE-01');
    expect(mobileFindings(timeline)[0]?.detector_id).toBe('CE-MOBILE-01');
  });

  it('still refuses the two rules that need a category rubric', async () => {
    for (const detector of ['CE-CONTENT-01', 'CE-VISUAL-01']) {
      const response = await h.request('/api/v1/scans', {
        method: 'POST',
        body: JSON.stringify(
          scanRequest({
            target_url: `${M2_FIXTURE_SITE_ORIGIN}/product-mobile-normal`,
            max_unique_pages: 1,
            detectors: [detector],
          }),
        ),
      });
      expect(response.status, detector).toBe(422);
    }
  });
});
