import { describe, expect, it } from 'vitest';
import {
  ASSET_DETECTOR_ID,
  classifyImage,
  evaluateProductImage,
  IMPLEMENTED_DETECTORS,
  type ImageObservation,
} from '@oe/domain';
import { parseImages } from '@oe/capture';

/**
 * MF-ASSET-01's rule table.
 *
 * M2's gate asks for "held-out positive/negative/blocked examples per detector; category
 * ambiguity; variant/tax/currency consistency; missing assets". Every abstention the detector
 * declares has a case here, because an abstention that is never exercised is a claim waiting
 * to happen.
 */

const TARGET = 'https://shop.example.com/img/front.png';
const NOW = '2026-09-21T12:00:00Z';

function observation(over: Partial<ImageObservation> = {}): ImageObservation {
  return {
    sessionId: 's1',
    evidenceId: 'e1',
    capturedAt: '2026-09-21T11:59:00Z',
    target: TARGET,
    contextKey: '/product|SIZE M|1280x900|de-DE',
    role: 'product',
    resourceStatus: 404,
    resourceByteLength: 9,
    rendered: false,
    timedOut: false,
    lazy: false,
    pageComplete: true,
    challenge: false,
    loginWall: false,
    ...over,
  };
}

/** Two independent sessions of the same image. */
function pair(over: Partial<ImageObservation> = {}, second: Partial<ImageObservation> = {}) {
  return [
    observation(over),
    observation({ sessionId: 's2', evidenceId: 'e2', ...over, ...second }),
  ];
}

const evaluate = (observations: ImageObservation[], now = NOW) =>
  evaluateProductImage({ target: TARGET, observations, now });

describe('known positive', () => {
  it('confirms a repeated 404 that also failed to render', () => {
    const result = evaluate(pair());
    expect(result.result).toBe('candidate');
    if (result.result !== 'candidate') throw new Error('unreachable');
    expect(result.reason).toBe('resource_error_status');
    expect(result.detector_id).toBe(ASSET_DETECTOR_ID);
    expect(result.proposed_grade).toBe('A');
    expect(result.requires_human_review).toBe(true);
    expect(result.claim).toContain('HTTP 404');
    expect(result.evidence_ids).toEqual(['e1', 'e2']);
    expect(result.limitations.join(' ')).toMatch(/revenue impact/i);
  });

  it('confirms a 200 that carried no bytes and painted nothing', () => {
    const result = evaluate(pair({ resourceStatus: 200, resourceByteLength: 0 }));
    expect(result.result).toBe('candidate');
    if (result.result !== 'candidate') throw new Error('unreachable');
    expect(result.reason).toBe('empty_response_body');
    expect(result.claim).toContain('empty body');
  });

  it('confirms an image that never answered at all', () => {
    const result = evaluate(pair({ resourceStatus: null, resourceByteLength: null }));
    expect(result.result).toBe('candidate');
    if (result.result !== 'candidate') throw new Error('unreachable');
    expect(result.reason).toBe('no_response');
  });
});

describe('negative control', () => {
  it('reports no finding when the image rendered in both checks', () => {
    const result = evaluate(
      pair({ resourceStatus: 200, resourceByteLength: 2269, rendered: true }),
    );
    expect(result.result).toBe('no_finding');
  });
});

describe('abstentions', () => {
  const cases: [string, ImageObservation[], string][] = [
    ['a single capture', [observation()], 'insufficient_independent_captures'],
    [
      'the same session recorded twice',
      [observation(), observation({ evidenceId: 'e2' })],
      'insufficient_independent_captures',
    ],
    ['an access challenge', pair({ challenge: true }), 'blocked'],
    ['a login wall', pair({ loginWall: true }), 'blocked'],
    [
      'an incomplete page capture',
      pair({ pageComplete: false }),
      'incomplete_or_ambiguous_capture',
    ],
    ['a decorative image', pair({ role: 'decorative' }), 'decorative_image'],
    ['an image whose role is not established', pair({ role: 'unknown' }), 'role_not_established'],
    ['an image still loading when the wait expired', pair({ timedOut: true }), 'pending_lazy_load'],
    [
      'a page that served a different variant',
      pair({}, { contextKey: '/product|SIZE L|1280x900|de-DE' }),
      'variant_changed',
    ],
    [
      'a page captured at a different viewport',
      pair({}, { contextKey: '/product|SIZE M|390x844|de-DE' }),
      'noncomparable_context',
    ],
    [
      'a capture older than the freshness policy',
      pair({ capturedAt: '2026-09-01T00:00:00Z' }),
      'stale_or_future_capture',
    ],
    [
      'observations that disagree about the status',
      pair({}, { resourceStatus: 500 }),
      'inconsistent_failure_kind',
    ],
    [
      'an image that rendered in one session but not the other',
      pair({}, { rendered: true, resourceStatus: 200, resourceByteLength: 2269 }),
      'inconsistent_failure_kind',
    ],
    [
      'a successful response that simply did not paint',
      pair({ resourceStatus: 200, resourceByteLength: 2269, rendered: false }),
      'rendered_without_resource_evidence',
    ],
  ];

  it.each(cases)('abstains on %s', (_name, observations, reason) => {
    const result = evaluate(observations);
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') throw new Error('unreachable');
    expect(result.reason).toBe(reason);
  });

  it('never returns a claim from an abstention', () => {
    for (const [, observations] of cases) {
      const result = evaluate(observations);
      expect(result).not.toHaveProperty('claim');
      expect(result.proposed_grade).toBeNull();
    }
  });

  it('rejects a future capture rather than treating it as fresh', () => {
    const result = evaluate(pair({ capturedAt: '2030-01-01T00:00:00Z' }));
    expect(result.result).toBe('unknown');
  });

  it('abstains when an observation names a different image', () => {
    const result = evaluate(pair({}, { target: 'https://shop.example.com/img/other.png' }));
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') throw new Error('unreachable');
    expect(result.reason).toBe('invalid_capture_record');
  });
});

describe('image classification', () => {
  it('calls a described image inside the content area product content', () => {
    expect(
      classifyImage({ alt: 'Overshirt, front view', presentational: false, insideMain: true }),
    ).toEqual({
      role: 'product',
      reason: 'described_image_in_main_content',
    });
  });

  it('calls an explicitly presentational image decorative', () => {
    expect(classifyImage({ alt: 'pattern', presentational: true, insideMain: true }).role).toBe(
      'decorative',
    );
  });

  it('calls an empty alt decorative, because that is what an empty alt means', () => {
    expect(classifyImage({ alt: '', presentational: false, insideMain: true }).role).toBe(
      'decorative',
    );
  });

  it('leaves an image with no alt attribute unknown rather than guessing', () => {
    expect(classifyImage({ alt: null, presentational: false, insideMain: true })).toEqual({
      role: 'unknown',
      reason: 'no_alt_attribute',
    });
  });

  it('leaves a described image outside the content area unknown', () => {
    expect(classifyImage({ alt: 'Logo', presentational: false, insideMain: false }).role).toBe(
      'unknown',
    );
  });
});

describe('image parsing', () => {
  const base = new URL('https://shop.example.com/product');

  it('resolves relative sources and records the attributes classification needs', () => {
    const images = parseImages(
      `<header><img src="/logo.png" alt="Shop"></header>
       <main><img src="img/front.png" alt="Front view" loading="lazy">
       <img src="/img/pattern.png" alt="" role="presentation"></main>`,
      base,
    );
    expect(images).toHaveLength(3);
    expect(images[0]).toMatchObject({
      src: 'https://shop.example.com/logo.png',
      insideMain: false,
    });
    expect(images[1]).toMatchObject({
      src: 'https://shop.example.com/img/front.png',
      alt: 'Front view',
      lazy: true,
      insideMain: true,
    });
    expect(images[2]).toMatchObject({ alt: '', presentational: true });
  });

  it('treats aria-hidden as presentational', () => {
    const [image] = parseImages('<main><img src="/a.png" alt="x" aria-hidden="true"></main>', base);
    expect(image!.presentational).toBe(true);
  });

  it('falls back to the first srcset candidate when there is no src', () => {
    const [image] = parseImages(
      '<main><img srcset="/a-2x.png 2x, /a.png 1x" alt="x"></main>',
      base,
    );
    expect(image!.src).toBe('https://shop.example.com/a-2x.png');
  });

  it('ignores inline data URIs, which carry no request to observe', () => {
    expect(
      parseImages('<main><img src="data:image/gif;base64,R0lGOD" alt="x"></main>', base),
    ).toEqual([]);
  });

  it('deduplicates the same image referenced twice', () => {
    const images = parseImages(
      '<main><img src="/a.png" alt="x"><img src="/a.png" alt="y"></main>',
      base,
    );
    expect(images).toHaveLength(1);
  });

  it('treats a page with no <main> as content, so alt text carries the decision', () => {
    const [image] = parseImages('<body><img src="/a.png" alt="Front view"></body>', base);
    expect(image!.insideMain).toBe(true);
  });
});

describe('implemented detector list', () => {
  it('names only detectors this build actually runs', () => {
    expect([...IMPLEMENTED_DETECTORS]).toEqual(['CE-LINK-01', 'CE-ASSET-01', 'CE-DATA-01']);
  });
});
