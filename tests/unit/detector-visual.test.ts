import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateVisualRubric,
  parseCategoryRubric,
  type CategoryRubric,
  type ProductImageObservation,
  type VisualDetectorInput,
  type VisualObservation,
} from '@oe/domain';

/**
 * CE-VISUAL-01, against the drafted rubric.
 *
 * The distinction these tests exist to pin down is the grade. A count is arithmetic over
 * recorded evidence and carries A; a gap in alt text is a gap in what the page *said*, not in
 * what it photographed, and carries B so that `checkActionReadiness` keeps it out of a
 * published report until a specialist has looked. Collapsing the two would let this system
 * tell a shop its photography is inadequate on the strength of its alt text.
 */

function rubric(): CategoryRubric {
  const document = JSON.parse(readFileSync('config/category-rubric.json', 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;
  document['approval'] = {
    approved_by_subject: 'owner@fixture.test',
    approved_at: '2026-09-22T00:00:00Z',
    approval_note: null,
  };
  const parsed = parseCategoryRubric(document);
  if (parsed.rubric === null) throw new Error(parsed.problems.join('; '));
  return parsed.rubric;
}

const NOW = '2026-09-22T12:00:00Z';
const TARGET = 'https://atelier-nord.test/product';

function image(overrides: Partial<ProductImageObservation> = {}): ProductImageObservation {
  return {
    evidenceId: 'evidence-1',
    src: '/img/product.png',
    alt: 'Everyday overshirt, front view',
    decorative: false,
    rendered: true,
    ...overrides,
  };
}

/** Front, back and a fabric detail: everything the rubric can read. */
const FULL_SET = [
  image({ src: '/img/front.png', alt: 'Everyday overshirt, front view' }),
  image({ src: '/img/back.png', alt: 'Everyday overshirt, back view' }),
  image({ src: '/img/detail.png', alt: 'Everyday overshirt, collar detail close-up' }),
];

function observation(
  images: ProductImageObservation[],
  overrides: Partial<VisualObservation> = {},
): VisualObservation {
  return {
    sessionId: 'session-1',
    evidenceId: 'evidence-1',
    capturedAt: '2026-09-22T11:59:00Z',
    target: TARGET,
    contextKey: 'de-DE|desktop',
    images,
    pageComplete: true,
    challenge: false,
    loginWall: false,
    ...overrides,
  };
}

function input(
  images: ProductImageObservation[],
  overrides: Partial<VisualDetectorInput> = {},
): VisualDetectorInput {
  return {
    target: TARGET,
    rubric: rubric(),
    observations: [
      observation(images),
      observation(images, { sessionId: 'session-2', evidenceId: 'evidence-2' }),
    ],
    now: NOW,
    ...overrides,
  };
}

describe('a page whose images answer what the rule can read', () => {
  it('produces no finding, and still hands over what only an eye can settle', () => {
    const result = evaluateVisualRubric(input(FULL_SET));
    expect(result.result).toBe('no_finding');
    if (result.result !== 'no_finding') return;
    // "No finding" must not read as "the photography is good". The open questions travel with
    // the result precisely so it cannot.
    expect(result.open_questions.join(' ')).toMatch(/colour/);
    expect(result.limitations.join(' ')).toMatch(
      /Nothing in this system looks at what a photograph shows/,
    );
  });
});

describe('too few images', () => {
  it('is a counted claim and carries grade A', () => {
    const result = evaluateVisualRubric(input(FULL_SET.slice(0, 2)));
    expect(result.result).toBe('candidate');
    if (result.result !== 'candidate') return;
    expect(result.reason).toBe('below_minimum_image_count');
    expect(result.image_count).toBe(2);
    expect(result.proposed_grade).toBe('A');
    expect(result.claim).toContain('2 product images');
  });

  it('does not count a decorative image toward the floor', () => {
    const result = evaluateVisualRubric(
      input([...FULL_SET.slice(0, 2), image({ src: '/img/badge.png', alt: '', decorative: true })]),
    );
    expect(result.result).toBe('candidate');
    if (result.result !== 'candidate') return;
    expect(result.image_count).toBe(2);
  });

  it('does not count an image that did not render', () => {
    const result = evaluateVisualRubric(
      input([...FULL_SET.slice(0, 2), image({ src: '/img/missing.png', rendered: false })]),
    );
    expect(result.result).toBe('candidate');
    if (result.result !== 'candidate') return;
    expect(result.image_count).toBe(2);
  });

  it('abstains rather than claiming a shortfall when there are no images at all', () => {
    // Usually a capture problem or a misidentified page, not a merchandising decision.
    const result = evaluateVisualRubric(input([]));
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') return;
    expect(result.reason).toBe('missing_images');
  });
});

describe('a gap in what the page said its images show', () => {
  it('carries grade B, and says in the claim that it is about descriptions', () => {
    const noBack = [
      image({ src: '/img/front.png', alt: 'Everyday overshirt, front view' }),
      image({ src: '/img/detail.png', alt: 'collar detail close-up' }),
      image({ src: '/img/three.png', alt: 'Everyday overshirt on a hanger' }),
    ];
    const result = evaluateVisualRubric(input(noBack));
    expect(result.result).toBe('candidate');
    if (result.result !== 'candidate') return;
    expect(result.reason).toBe('declared_shot_coverage_incomplete');
    // The whole point of the grade split.
    expect(result.proposed_grade).toBe('B');
    expect(result.claim).toMatch(/what the page said its images show, not about what they show/);
    expect(result.shots.find((shot) => shot.key === 'back')?.declared).toBe(false);
  });

  it('never claims a shot type the rubric says cannot be read from a page', () => {
    const result = evaluateVisualRubric(input(FULL_SET));
    if (result.result !== 'no_finding') throw new Error('expected no finding');
    // `worn-on-body` is `not detectable`. It must not have quietly become a passing check
    // either: its absence from the finding path is the point.
    const parsed = rubric();
    expect(
      parsed.visual.requiredShots.find((shot) => shot.key === 'worn-on-body')?.detectableFrom,
    ).toBe('not detectable');
  });

  it('abstains when no image carries any description at all', () => {
    // Saying "no image shows the back" here would be describing the alt text while appearing
    // to describe the photographs. That the alt text is missing is CE-ASSET-01's business.
    const silent = [
      image({ src: '/img/a.png', alt: '' }),
      image({ src: '/img/b.png', alt: '' }),
      image({ src: '/img/c.png', alt: '' }),
    ];
    const result = evaluateVisualRubric(input(silent));
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') return;
    expect(result.reason).toBe('shot_coverage_not_declared');
  });
});

describe('capture integrity, before any judgement', () => {
  it('abstains with no rubric rather than inventing a standard', () => {
    const result = evaluateVisualRubric(input(FULL_SET, { rubric: null }));
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') return;
    expect(result.reason).toBe('unsupported_category');
  });

  it('abstains when the gallery differs between sessions', () => {
    const result = evaluateVisualRubric({
      target: TARGET,
      rubric: rubric(),
      observations: [
        observation(FULL_SET),
        observation(FULL_SET.slice(0, 2), { sessionId: 'session-2', evidenceId: 'evidence-2' }),
      ],
      now: NOW,
    });
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') return;
    expect(result.reason).toBe('image_set_not_stable_across_captures');
  });

  it('abstains on a single capture', () => {
    const result = evaluateVisualRubric({
      target: TARGET,
      rubric: rubric(),
      observations: [observation(FULL_SET)],
      now: NOW,
    });
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') return;
    expect(result.reason).toBe('insufficient_independent_captures');
  });

  it('abstains on a blocked capture', () => {
    const result = evaluateVisualRubric(
      input(FULL_SET, {
        observations: [
          observation(FULL_SET, { loginWall: true }),
          observation(FULL_SET, { sessionId: 'session-2', evidenceId: 'evidence-2' }),
        ],
      }),
    );
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') return;
    expect(result.reason).toBe('blocked');
  });

  it('abstains on a stale capture', () => {
    const result = evaluateVisualRubric(
      input(FULL_SET, {
        observations: [
          observation(FULL_SET, { capturedAt: '2020-01-01T00:00:00Z' }),
          observation(FULL_SET, { sessionId: 'session-2', evidenceId: 'evidence-2' }),
        ],
      }),
    );
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') return;
    expect(result.reason).toBe('stale_or_future_capture');
  });
});
