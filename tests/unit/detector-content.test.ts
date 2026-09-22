import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateCategoryContent,
  parseCategoryRubric,
  type CategoryRubric,
  type ContentDetectorInput,
  type ContentObservation,
} from '@oe/domain';

/**
 * CE-CONTENT-01, against the rubric this build actually drafted.
 *
 * The rubric is loaded from config/ and signed in memory rather than being invented here, so
 * these tests break if the real file's patterns stop matching pages they should match. A
 * detector proved against a fixture rubric would prove nothing about the one in use.
 */

function rubric(): CategoryRubric {
  const document = JSON.parse(readFileSync('config/category-rubric.json', 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;
  document['approval'] = {
    approved_by_subject: 'owner@fixture.test',
    approved_at: '2026-09-22T00:00:00Z',
    approval_note: 'Signed in a test, not in life.',
  };
  const parsed = parseCategoryRubric(document);
  if (parsed.rubric === null) throw new Error(parsed.problems.join('; '));
  return parsed.rubric;
}

const NOW = '2026-09-22T12:00:00Z';
const TARGET = 'https://atelier-nord.test/product';

const COMPLETE_PAGE = `
  Everyday overshirt. EUR 89.00.
  Material: 80% Baumwolle, 20% Wolle.
  Größentabelle: Brustumfang 104 cm, Rückenlänge 72 cm.
  14 Tage Rückgaberecht.
  Pflegehinweise: 30 Grad waschen.
`;

function observation(overrides: Partial<ContentObservation> = {}): ContentObservation {
  return {
    sessionId: 'session-1',
    evidenceId: 'evidence-1',
    capturedAt: '2026-09-22T11:59:00Z',
    target: TARGET,
    contextKey: 'de-DE|desktop',
    text: COMPLETE_PAGE,
    undisclosedRegions: [],
    pageComplete: true,
    challenge: false,
    loginWall: false,
    ...overrides,
  };
}

function input(overrides: Partial<ContentDetectorInput> = {}): ContentDetectorInput {
  return {
    target: TARGET,
    rubric: rubric(),
    observations: [
      observation(),
      observation({ sessionId: 'session-2', evidenceId: 'evidence-2' }),
    ],
    linkedPages: [],
    linkedPagesComplete: true,
    now: NOW,
    ...overrides,
  };
}

/** A page missing one required item, the rest intact. */
function without(item: 'materials' | 'size' | 'returns'): string {
  const lines = COMPLETE_PAGE.split('\n').filter((line) => {
    if (item === 'materials') return !/Material|Baumwolle/.test(line);
    if (item === 'size') return !/Größentabelle|Brustumfang/.test(line);
    return !/Rückgaberecht/.test(line);
  });
  return lines.join('\n');
}

describe('a page that says everything', () => {
  it('produces no finding, and reports the expected items it also saw', () => {
    const result = evaluateCategoryContent(input());
    expect(result.result).toBe('no_finding');
    if (result.result !== 'no_finding') return;
    expect(result.reason).toBe('all_required_buying_information_stated');
    const care = result.expected_observed.find((entry) => entry.key === 'care_instructions');
    expect(care?.stated).toBe(true);
    // Never claimed, only reported: the absence of an expected item is not a defect.
    const model = result.expected_observed.find((entry) => entry.key === 'model_reference');
    expect(model?.stated).toBe(false);
  });
});

describe('a page missing something the category requires', () => {
  it('names the buyer question rather than the field', () => {
    const text = without('materials');
    const result = evaluateCategoryContent(
      input({
        observations: [
          observation({ text }),
          observation({ sessionId: 'session-2', evidenceId: 'evidence-2', text }),
        ],
      }),
    );
    expect(result.result).toBe('candidate');
    if (result.result !== 'candidate') return;
    expect(result.missing.map((entry) => entry.key)).toEqual(['materials']);
    // The claim is written for somebody who does not know what a "rubric key" is.
    expect(result.claim).toContain('What is it made of?');
    expect(result.proposed_grade).toBe('A');
    expect(result.requires_human_review).toBe(true);
  });

  it('carries the contested list into the finding as what it declined to judge', () => {
    const text = without('materials');
    const result = evaluateCategoryContent(
      input({
        observations: [
          observation({ text }),
          observation({ sessionId: 'session-2', evidenceId: 'evidence-2', text }),
        ],
      }),
    );
    if (result.result !== 'candidate') throw new Error('expected a candidate');
    expect(result.not_judged.length).toBeGreaterThan(2);
    expect(result.not_judged.join(' ')).toMatch(/fit description/);
  });

  it('states in its own limitations that it did not judge whether the answer was any good', () => {
    const result = evaluateCategoryContent(input());
    expect(result.limitations.join(' ')).toMatch(/not whether what it states is adequate/);
  });
});

describe('what it refuses to call missing', () => {
  it('abstains when a required item could be on a page the scan did not inspect', () => {
    // `returns_window` is allowed on a linked page, and the sample has holes. "Missing" would
    // be a claim about pages nobody looked at.
    const text = without('returns');
    const result = evaluateCategoryContent(
      input({
        observations: [
          observation({ text }),
          observation({ sessionId: 'session-2', evidenceId: 'evidence-2', text }),
        ],
        linkedPagesComplete: false,
      }),
    );
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') return;
    expect(result.reason).toBe('sample_incomplete');
  });

  it('finds a required item on a linked page the scan did inspect', () => {
    const text = without('returns');
    const result = evaluateCategoryContent(
      input({
        observations: [
          observation({ text }),
          observation({ sessionId: 'session-2', evidenceId: 'evidence-2', text }),
        ],
        linkedPages: [
          {
            evidenceId: 'evidence-3',
            url: 'https://atelier-nord.test/versand-rueckgabe',
            text: 'Widerrufsrecht: 14 Tage Rückgaberecht ab Erhalt.',
          },
        ],
      }),
    );
    expect(result.result).toBe('no_finding');
  });

  it('does not accept a linked page for an item the rubric keeps on the page itself', () => {
    // `materials` is `may_be_on_a_linked_page: false`. A fibre list buried in a generic FAQ is
    // not the product page stating what this garment is made of.
    const text = without('materials');
    const result = evaluateCategoryContent(
      input({
        observations: [
          observation({ text }),
          observation({ sessionId: 'session-2', evidenceId: 'evidence-2', text }),
        ],
        linkedPages: [
          {
            evidenceId: 'evidence-3',
            url: 'https://atelier-nord.test/faq',
            text: 'Material: wool.',
          },
        ],
      }),
    );
    expect(result.result).toBe('candidate');
  });

  it('abstains when the page announced a region it did not disclose', () => {
    const text = without('materials');
    const result = evaluateCategoryContent(
      input({
        observations: [
          observation({ text, undisclosedRegions: ['empty <details> region'] }),
          observation({
            sessionId: 'session-2',
            evidenceId: 'evidence-2',
            text,
            undisclosedRegions: ['empty <details> region'],
          }),
        ],
      }),
    );
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') return;
    expect(result.reason).toBe('hidden_content_not_inspected');
  });

  it('ignores an undisclosed region on a page that stated everything anyway', () => {
    // Abstaining here would throw away a correct answer over a risk that could not have
    // changed it.
    const result = evaluateCategoryContent(
      input({
        observations: [
          observation({ undisclosedRegions: ['region declared as loaded on demand'] }),
          observation({
            sessionId: 'session-2',
            evidenceId: 'evidence-2',
            undisclosedRegions: ['region declared as loaded on demand'],
          }),
        ],
      }),
    );
    expect(result.result).toBe('no_finding');
  });

  it('abstains when two captures disagree about what the page said', () => {
    const result = evaluateCategoryContent(
      input({
        observations: [
          observation(),
          observation({
            sessionId: 'session-2',
            evidenceId: 'evidence-2',
            text: without('materials'),
          }),
        ],
      }),
    );
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') return;
    expect(result.reason).toBe('content_not_stable_across_captures');
  });

  it('abstains with no rubric, rather than inventing a standard', () => {
    const result = evaluateCategoryContent(input({ rubric: null }));
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') return;
    expect(result.reason).toBe('category_unknown');
  });
});

describe('capture integrity, before any judgement', () => {
  const cases: [string, Partial<ContentDetectorInput>][] = [
    ['insufficient_independent_captures', { observations: [observation()] }],
    [
      'insufficient_independent_captures',
      { observations: [observation(), observation({ evidenceId: 'evidence-2' })] },
    ],
    [
      'noncomparable_context',
      {
        observations: [
          observation(),
          observation({
            sessionId: 'session-2',
            evidenceId: 'evidence-2',
            contextKey: 'en-GB|desktop',
          }),
        ],
      },
    ],
    [
      'blocked',
      {
        observations: [
          observation({ challenge: true }),
          observation({ sessionId: 'session-2', evidenceId: 'evidence-2' }),
        ],
      },
    ],
    [
      'incomplete_or_ambiguous_capture',
      {
        observations: [
          observation({ pageComplete: false }),
          observation({ sessionId: 'session-2', evidenceId: 'evidence-2' }),
        ],
      },
    ],
    [
      'stale_or_future_capture',
      {
        observations: [
          observation({ capturedAt: '2020-01-01T00:00:00Z' }),
          observation({ sessionId: 'session-2', evidenceId: 'evidence-2' }),
        ],
      },
    ],
    ['invalid_freshness_policy', { maxAgeMs: 0 }],
  ];

  for (const [reason, overrides] of cases) {
    it(`abstains with ${reason}`, () => {
      const result = evaluateCategoryContent(input(overrides));
      expect(result.result).toBe('unknown');
      if (result.result !== 'unknown') return;
      expect(result.reason).toBe(reason);
    });
  }

  it('abstains on an observation about a different page', () => {
    const result = evaluateCategoryContent(
      input({
        observations: [
          observation(),
          observation({
            sessionId: 'session-2',
            evidenceId: 'evidence-2',
            target: 'https://elsewhere.test/',
          }),
        ],
      }),
    );
    expect(result.result).toBe('unknown');
    if (result.result !== 'unknown') return;
    expect(result.reason).toBe('invalid_capture_record');
  });
});
