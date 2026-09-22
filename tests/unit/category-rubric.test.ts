import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCategoryRubric, statesPattern } from '@oe/domain';

/**
 * The rubric is the only place in this system where a commercial judgement decides whether
 * something is a defect. That makes the parser a safety control rather than a convenience:
 * everything it lets through becomes a sentence in front of a customer.
 */

const DRAFT = JSON.parse(readFileSync('config/category-rubric.json', 'utf8')) as unknown;
const TEMPLATE = JSON.parse(readFileSync('config/category-rubric.example.json', 'utf8')) as unknown;

/** A minimal rubric that passes, so each test can break exactly one thing. */
function valid(): Record<string, unknown> {
  return {
    category: {
      key: 'apparel-everyday-layers',
      label: 'Everyday layers',
      why_this_one: 'Because.',
    },
    content: {
      required: [
        {
          key: 'materials',
          question_a_buyer_asks: 'What is it made of?',
          why_required: 'Fibre content decides whether it itches.',
          how_a_page_states_it: ['Material', 'Zusammensetzung'],
          may_be_on_a_linked_page: false,
        },
      ],
      expected: [],
      contested: ['whether a fit description is buying information'],
    },
    visual: {
      required_shots: [
        {
          key: 'front-full',
          question_a_buyer_asks: 'What does it look like?',
          detectable_from: 'alt text',
          alt_text_patterns: ['front'],
        },
      ],
      minimum_product_images: 3,
      needs_a_human: ['whether the colour is true to life'],
    },
    approval: {
      approved_by_subject: 'owner@fixture.test',
      approved_at: '2026-09-22T00:00:00Z',
      approval_note: null,
    },
  };
}

describe('the drafted rubric in config/', () => {
  it('is structurally valid but unapproved, so both detectors stay unrequestable', () => {
    const result = parseCategoryRubric(DRAFT);
    expect(result.rubric).toBeNull();
    // The distinction that matters to anybody debugging this: nothing is wrong with the file.
    // Nobody has signed it.
    expect(result.unapprovedOnly).toBe(true);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/no owner approval/);
  });

  it('becomes usable the moment somebody signs it, with nothing else changed', () => {
    const signed = JSON.parse(JSON.stringify(DRAFT)) as Record<string, unknown>;
    (signed['approval'] as Record<string, unknown>)['approved_by_subject'] = 'owner@fixture.test';
    (signed['approval'] as Record<string, unknown>)['approved_at'] = '2026-09-22T00:00:00Z';
    const { rubric, problems } = parseCategoryRubric(signed);
    expect(problems).toEqual([]);
    expect(rubric?.key).toBe('apparel-everyday-layers');
    expect(rubric?.content.required.map((item) => item.key)).toEqual([
      'materials',
      'size_measurements',
      'returns_window',
    ]);
    expect(rubric?.visual.minimumProductImages).toBe(3);
  });

  it('records which judgements its author was unsure about', () => {
    // These are arguments, and a year from now nobody will remember which items were fought
    // over. The file is the only place that keeps it.
    const required = (DRAFT as Record<string, Record<string, Record<string, unknown>[]>>)[
      'content'
    ]!['required']!;
    const confidences = required.map((item) => item['drafted_confidence']);
    expect(confidences).toContain('medium');
    expect(
      (DRAFT as Record<string, string[]>)['$what_I_am_least_sure_about']!.length,
    ).toBeGreaterThan(2);
  });
});

describe('the template is still a template', () => {
  it('does not parse, because every placeholder is caught', () => {
    const result = parseCategoryRubric(TEMPLATE);
    expect(result.rubric).toBeNull();
    // A half-filled template reaching a deployment would produce findings about pages that
    // failed to say "FILL IN".
    expect(result.problems.some((problem) => /placeholder/.test(problem))).toBe(true);
  });
});

describe('what the parser refuses', () => {
  it('accepts the minimal valid rubric', () => {
    expect(parseCategoryRubric(valid()).problems).toEqual([]);
  });

  it('refuses a rubric with nothing contested', () => {
    const rubric = valid();
    (rubric['content'] as Record<string, unknown>)['contested'] = [];
    const { problems } = parseCategoryRubric(rubric);
    expect(problems.some((problem) => /contested/.test(problem))).toBe(true);
  });

  it('refuses a required item with no reason for being required', () => {
    const rubric = valid();
    const required = (rubric['content'] as Record<string, unknown[]>)['required']!;
    delete (required[0] as Record<string, unknown>)['why_required'];
    const { problems } = parseCategoryRubric(rubric);
    expect(problems.some((problem) => /why_required/.test(problem))).toBe(true);
  });

  it('refuses an item with nothing to match, which would abstain on every page', () => {
    const rubric = valid();
    const required = (rubric['content'] as Record<string, unknown[]>)['required']!;
    (required[0] as Record<string, unknown>)['how_a_page_states_it'] = [];
    const { problems } = parseCategoryRubric(rubric);
    expect(problems.some((problem) => /how_a_page_states_it/.test(problem))).toBe(true);
  });

  it('refuses a shot claimed readable from alt text with no patterns to read', () => {
    const rubric = valid();
    const shots = (rubric['visual'] as Record<string, unknown[]>)['required_shots']!;
    (shots[0] as Record<string, unknown>)['alt_text_patterns'] = [];
    const { problems } = parseCategoryRubric(rubric);
    expect(problems.some((problem) => /alt_text_patterns/.test(problem))).toBe(true);
  });

  it('refuses a rubric that claims everything about images is machine-checkable', () => {
    const rubric = valid();
    (rubric['visual'] as Record<string, unknown>)['needs_a_human'] = [];
    const { problems } = parseCategoryRubric(rubric);
    expect(problems.some((problem) => /needs_a_human/.test(problem))).toBe(true);
  });

  it('refuses the same item in two tiers', () => {
    const rubric = valid();
    (rubric['content'] as Record<string, unknown[]>)['expected'] = [
      { key: 'materials', question_a_buyer_asks: 'again?', how_a_page_states_it: ['Material'] },
    ];
    const { problems } = parseCategoryRubric(rubric);
    expect(problems.some((problem) => /appears twice/.test(problem))).toBe(true);
  });

  it('does not report a structural problem as merely unapproved', () => {
    const rubric = valid();
    (rubric['approval'] as Record<string, unknown>)['approved_by_subject'] = null;
    (rubric['content'] as Record<string, unknown>)['contested'] = [];
    const result = parseCategoryRubric(rubric);
    // Both are wrong, so "just needs a signature" would send somebody looking in the wrong place.
    expect(result.unapprovedOnly).toBe(false);
  });

  it('refuses an approval time that is not a time', () => {
    const rubric = valid();
    (rubric['approval'] as Record<string, unknown>)['approved_at'] = 'soon';
    expect(parseCategoryRubric(rubric).rubric).toBeNull();
  });
});

describe('statesPattern', () => {
  it('matches across case and collapsed whitespace', () => {
    expect(statesPattern('Material:\n  100% WOOL', 'material')).toBe(true);
    expect(statesPattern('14   Tage   Rückgaberecht', '14 Tage Rückgaberecht')).toBe(true);
  });

  it('matches patterns carrying punctuation and digits', () => {
    // A word-boundary match would drop both of these, which is why it is not used.
    expect(statesPattern('Zusammensetzung: 80% Baumwolle', '% Baumwolle')).toBe(true);
    expect(statesPattern('30 days to return', 'days to return')).toBe(true);
  });

  it('does not match what is not there', () => {
    expect(statesPattern('Everyday overshirt', 'Material')).toBe(false);
  });
});
