import { describe, expect, it } from 'vitest';
import {
  evaluateMobileObstruction,
  MOBILE_DETECTOR_ID,
  type MobileObservation,
  type OverlayObservation,
} from '@oe/domain';

/**
 * CE-MOBILE-01, and the line between an obstruction and normal furniture.
 *
 * `contracts/detectors.json` requires "actual obstruction at recorded viewport with DOM/image
 * evidence and repeated state", abstaining on `user_dismissible_overlay_not_tested`,
 * `transient_loading` and `missing_viewport`.
 *
 * The failure to guard against is calling a sticky header a defect. Almost every site has one,
 * so a rule that flagged them would be wrong nearly everywhere — which is why the threshold
 * below is deliberately generous to the page.
 */

const NOW = '2026-09-22T12:00:00Z';
const TARGET = 'https://shop.example.com/products/jacket';
const PHONE = { width: 390, height: 844 };

function overlay(over: Partial<OverlayObservation> = {}): OverlayObservation {
  return {
    key: 'div#consent.bar',
    position: 'fixed',
    // A third of the screen, at the bottom, over the content.
    rect: { x: 0, y: 560, width: 390, height: 284 },
    hasDismissControl: false,
    looksTransient: false,
    ...over,
  };
}

function observation(over: Partial<MobileObservation> = {}): MobileObservation {
  return {
    sessionId: 's1',
    evidenceId: 'e1',
    capturedAt: '2026-09-22T11:59:00Z',
    target: TARGET,
    contextKey: '/products/jacket|no-variant|390x844|de-DE',
    viewport: PHONE,
    contentRect: { x: 0, y: 100, width: 390, height: 700 },
    overlays: [overlay()],
    pageComplete: true,
    challenge: false,
    loginWall: false,
    ...over,
  };
}

function pair(over: Partial<MobileObservation> = {}): MobileObservation[] {
  return [observation(over), observation({ ...over, sessionId: 's2', evidenceId: 'e2' })];
}

const run = (observations: MobileObservation[], now = NOW) =>
  evaluateMobileObstruction({ target: TARGET, observations, now });

describe('the known positive', () => {
  it('reports a candidate for a persistent, undismissable cover', () => {
    const result = run(pair());
    expect(result.result).toBe('candidate');
    if (result.result !== 'candidate') throw new Error('unreachable');
    expect(result.detector_id).toBe(MOBILE_DETECTOR_ID);
    expect(result.proposed_grade).toBe('A');
    expect(result.claim).toContain('390×844');
    expect(result.claim).toContain('no visible way to close it');
    expect(result.evidence_ids).toEqual(['e1', 'e2']);
  });

  it('tells a reviewer what it did not test', () => {
    const result = run(pair());
    // The two caveats that decide whether this finding means anything.
    expect(result.limitations.join(' ')).toContain('Nothing was tapped');
    expect(result.limitations.join(' ')).toContain('added by JavaScript are not visible');
  });
});

describe('normal furniture', () => {
  it('says nothing about a conventional sticky header', () => {
    // 48 pixels on an 844-pixel screen is 6%. Almost every site has one, and a rule that
    // flagged them would be wrong nearly everywhere.
    const result = run(
      pair({
        overlays: [
          overlay({
            key: 'header#top.site',
            position: 'sticky',
            rect: { x: 0, y: 0, width: 390, height: 48 },
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      result: 'no_finding',
      reason: 'no_persistent_obstruction_at_this_viewport',
    });
  });

  it('says nothing about a large element that sits beside the content', () => {
    // Big, but not over the thing the page is about.
    const result = run(
      pair({
        contentRect: { x: 0, y: 0, width: 390, height: 300 },
        overlays: [overlay({ rect: { x: 0, y: 560, width: 390, height: 284 } })],
      }),
    );
    expect(result.result).toBe('no_finding');
  });

  it('measures only the part of an element that is on screen', () => {
    // An element hanging off the bottom obstructs what is on the screen, not its own height.
    const result = run(
      pair({
        overlays: [overlay({ rect: { x: 0, y: 800, width: 390, height: 900 } })],
      }),
    );
    expect(result.result).toBe('no_finding');
  });

  it('says nothing when the page has no overlays at all', () => {
    expect(run(pair({ overlays: [] })).result).toBe('no_finding');
  });
});

describe('the abstentions the contract names', () => {
  it('abstains when the cover carries a visible way to close it', () => {
    // It might vanish on the first tap. This rule taps nothing, so it cannot tell.
    const result = run(pair({ overlays: [overlay({ hasDismissControl: true })] }));
    expect(result).toMatchObject({
      result: 'unknown',
      reason: 'user_dismissible_overlay_not_tested',
    });
  });

  it('abstains on something announcing itself as a loading state', () => {
    const result = run(pair({ overlays: [overlay({ looksTransient: true })] }));
    expect(result).toMatchObject({ result: 'unknown', reason: 'transient_loading' });
  });

  it('abstains when no viewport was recorded', () => {
    expect(run(pair({ viewport: null }))).toMatchObject({
      result: 'unknown',
      reason: 'missing_viewport',
    });
  });
});

describe('the abstentions this rule adds', () => {
  it('refuses to report a desktop measurement under a mobile heading', () => {
    const desktop = { width: 1280, height: 900 };
    const result = run(
      pair({
        viewport: desktop,
        contextKey: '/products/jacket|no-variant|1280x900|de-DE',
        overlays: [overlay({ rect: { x: 0, y: 500, width: 1280, height: 400 } })],
      }),
    );
    expect(result).toMatchObject({ result: 'unknown', reason: 'not_a_phone_viewport' });
  });

  it('abstains when the page exposes no content region to measure against', () => {
    expect(run(pair({ contentRect: null }))).toMatchObject({
      result: 'unknown',
      reason: 'content_region_not_established',
    });
  });

  it('abstains when the cover appeared in one check and not the other', () => {
    // Seen once is not persistent, and it is a different answer from "nothing covered it".
    const [a, b] = pair();
    expect(run([a!, { ...b!, overlays: [] }])).toMatchObject({
      result: 'unknown',
      reason: 'obstruction_not_repeated',
    });
  });

  it('abstains when two different elements covered the page, one each time', () => {
    const [a, b] = pair();
    expect(run([a!, { ...b!, overlays: [overlay({ key: 'div#promo.banner' })] }])).toMatchObject({
      result: 'unknown',
      reason: 'obstruction_not_repeated',
    });
  });
});

describe('the abstentions every detector in this build shares', () => {
  it('abstains on one capture, and on two from one session', () => {
    expect(run([observation()])).toMatchObject({
      result: 'unknown',
      reason: 'insufficient_independent_captures',
    });
    expect(run([observation(), observation({ evidenceId: 'e2' })])).toMatchObject({
      result: 'unknown',
      reason: 'insufficient_independent_captures',
    });
  });

  it('abstains on a challenge, a login wall and an incomplete capture', () => {
    expect(run(pair({ challenge: true })).result).toBe('unknown');
    expect(run(pair({ loginWall: true })).result).toBe('unknown');
    expect(run(pair({ pageComplete: false }))).toMatchObject({
      result: 'unknown',
      reason: 'incomplete_or_ambiguous_capture',
    });
  });

  it('abstains on stale and future captures', () => {
    expect(run(pair({ capturedAt: '2026-08-01T00:00:00Z' }))).toMatchObject({
      result: 'unknown',
      reason: 'stale_or_future_capture',
    });
    expect(run(pair({ capturedAt: '2026-12-01T00:00:00Z' })).result).toBe('unknown');
  });

  it('abstains when the two captures were of different page states', () => {
    const [a, b] = pair();
    expect(run([a!, { ...b!, contextKey: 'other' }])).toMatchObject({
      result: 'unknown',
      reason: 'noncomparable_context',
    });
  });

  it('never proposes a grade or a claim when it abstains', () => {
    const result = run(pair({ overlays: [overlay({ hasDismissControl: true })] }));
    expect(result.proposed_grade).toBeNull();
    expect(Object.keys(result)).not.toContain('claim');
  });
});
