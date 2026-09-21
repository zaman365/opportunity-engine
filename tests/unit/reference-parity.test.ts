import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aggregateNeed,
  checkActionReadiness,
  contributionScenario,
  evaluateImportantLink,
  MACHINES,
  micro,
  preflightTarget,
  remaining,
  scoreOpportunity,
  transition,
} from '@oe/domain';

// The kit's reference modules stay byte-identical; these tests import them directly and
// assert the TypeScript port agrees, so `packages/domain` cannot drift from the handoff.
import * as refScoring from '../../opportunity-engine-build-kit/reference/scoring.mjs';
import * as refMoney from '../../opportunity-engine-build-kit/reference/money.mjs';
import * as refDetector from '../../opportunity-engine-build-kit/reference/detector-link.mjs';
import * as refUrl from '../../opportunity-engine-build-kit/reference/url-policy.mjs';
import * as refState from '../../opportunity-engine-build-kit/reference/state-machine.mjs';

describe('scoring parity', () => {
  const cases = [
    { fit: 0.9, need: 0.85, deliverability: 0.9, timing: 0.5, value: 0.7 },
    { fit: 0.9, need: 0.85, deliverability: 0.9, timing: null, value: 0.7 },
    { fit: 0, need: 0, deliverability: 0, timing: 0, value: 0 },
    { fit: 1, need: 1, deliverability: 1, timing: 1, value: 1 },
    { fit: null, need: null, deliverability: null, timing: null, value: null },
  ];

  it.each(cases)('matches the reference for %j', (dimensions) => {
    expect(scoreOpportunity(dimensions)).toEqual(refScoring.scoreOpportunity(dimensions));
  });

  it('rejects an omitted dimension rather than scoring it as zero', () => {
    // @ts-expect-error deliberately incomplete input
    expect(() => scoreOpportunity({ fit: 1, need: 1, deliverability: 1, timing: 1 })).toThrow(TypeError);
  });

  it('reports an interval and coverage when an input is unknown', () => {
    const score = scoreOpportunity({ fit: 0.9, need: 0.85, deliverability: 0.9, timing: null, value: 0.7 });
    expect(score.pointScore).toBeNull();
    expect(score.rankable).toBe(false);
    expect(score.lowerBound).toBeLessThan(score.upperBound);
    expect(score.weightedCoverage).toBeCloseTo(0.85, 10);
  });

  it('deduplicates need by root cause exactly as the reference does', () => {
    const findings = [
      { rootCauseKey: 'a', severity: 0.8 },
      { rootCauseKey: 'a', severity: 0.4 },
      { rootCauseKey: 'b', severity: 0.6 },
      { rootCauseKey: 'c', severity: 0.5 },
    ];
    expect(aggregateNeed(findings)).toEqual(refScoring.aggregateNeed(findings));
    expect(aggregateNeed(findings).rootCauseCount).toBe(3);
  });

  it('matches the reference readiness gate', () => {
    const input = {
      action: 'publish_report' as const,
      evidenceGrade: 'A' as const,
      evidenceFresh: true,
      humanApproved: true,
      budgetAvailable: true,
      policyRecord: {
        decision: 'allow' as const,
        action: 'publish_report',
        version: 'v1',
        expiresAt: '2030-01-01T00:00:00Z',
      },
      now: '2026-09-21T00:00:00Z',
    };
    expect(checkActionReadiness(input)).toEqual(refScoring.checkActionReadiness(input));
    const denied = { ...input, policyRecord: null };
    expect(checkActionReadiness(denied)).toEqual(refScoring.checkActionReadiness(denied));
    expect(checkActionReadiness(denied).allowed).toBe(false);
  });

  it('matches the reference contribution scenario', () => {
    const input = { orders: 5, netPrice: 790, deliveryCostPerOrder: 320, acquisitionCost: 855 };
    expect(contributionScenario(input)).toEqual(refScoring.contributionScenario(input));
  });
});

describe('money parity', () => {
  it('parses canonical micro strings identically', () => {
    expect(micro('123456')).toBe(refMoney.micro('123456'));
    expect(() => micro('01')).toThrow();
    expect(() => micro('-1')).toThrow();
    expect(() => micro('1.5')).toThrow();
  });

  it('computes remaining balance identically, including overrun', () => {
    const input = { limit: '1000', settled: '400', reserved: '700' };
    expect(remaining(input)).toEqual(refMoney.remaining(input));
    expect(remaining(input).overrun).toBe(true);
  });
});

describe('url policy parity', () => {
  const hosts = ['merchant.example.com', 'shop.test-brand.de'];
  const targets = [
    'https://shop.test-brand.de/product/1',
    'https://shop.test-brand.de/cart/add',
    'https://shop.test-brand.de/p?token=secret',
    'http://shop.test-brand.de/product',
    'https://127.0.0.1/product',
    'https://evil.com/product',
    'https://sub.shop.test-brand.de/product',
    'https://user:pw@shop.test-brand.de/product',
    'https://shop.test-brand.de:8443/product',
    'javascript:alert(1)',
  ];

  it.each(targets)('matches the reference verdict for %s', (target) => {
    expect(preflightTarget(target, hosts)).toEqual(refUrl.preflightTarget(target, hosts));
  });
});

describe('state machine parity', () => {
  it('has the same edges as contracts/state-machines.json', () => {
    const contract = JSON.parse(
      readFileSync(
        new URL('../../opportunity-engine-build-kit/contracts/state-machines.json', import.meta.url),
        'utf8',
      ),
    ).machines;
    expect(JSON.parse(JSON.stringify(MACHINES))).toEqual(contract);
    expect(JSON.parse(JSON.stringify(MACHINES))).toEqual(JSON.parse(JSON.stringify(refState.MACHINES)));
  });

  it('rejects a stale expected version', () => {
    expect(() =>
      transition({ kind: 'finding', state: 'candidate', version: 3, expectedVersion: 2, next: 'confirmed' }),
    ).toThrowError(/Reload and re-review/);
  });

  it('rejects an edge the contract does not allow', () => {
    expect(() =>
      transition({ kind: 'report', state: 'draft', version: 1, expectedVersion: 1, next: 'published' }),
    ).toThrowError(/cannot transition/);
  });
});

describe('MF-LINK-01 parity', () => {
  const base = {
    linkKind: 'important_information',
    navigationApproved: true,
    target: 'https://shop.example.com/size-guide',
    now: '2026-09-21T10:00:00Z',
  };
  const observation = (over: Record<string, unknown> = {}) => ({
    sessionId: 's1',
    evidenceId: 'e1',
    capturedAt: '2026-09-21T09:59:00Z',
    target: base.target,
    contextKey: 'ctx',
    status: 404,
    complete: true,
    challenge: false,
    loginWall: false,
    soft404: false,
    ...over,
  });

  const cases: Record<string, unknown> = {
    'two independent 404s': {
      ...base,
      observations: [observation(), observation({ sessionId: 's2', evidenceId: 'e2' })],
    },
    'healthy destination': {
      ...base,
      observations: [
        observation({ status: 200 }),
        observation({ sessionId: 's2', evidenceId: 'e2', status: 200 }),
      ],
    },
    'single capture only': { ...base, observations: [observation()] },
    'same session twice': {
      ...base,
      observations: [observation(), observation({ evidenceId: 'e2' })],
    },
    'challenge page': {
      ...base,
      observations: [
        observation({ challenge: true }),
        observation({ sessionId: 's2', evidenceId: 'e2', challenge: true }),
      ],
    },
    'soft 404': {
      ...base,
      observations: [
        observation({ status: 200, soft404: true }),
        observation({ sessionId: 's2', evidenceId: 'e2', status: 200, soft404: true }),
      ],
    },
    'mismatched status': {
      ...base,
      observations: [observation(), observation({ sessionId: 's2', evidenceId: 'e2', status: 410 })],
    },
    'different variant context': {
      ...base,
      observations: [observation(), observation({ sessionId: 's2', evidenceId: 'e2', contextKey: 'other' })],
    },
    'stale capture': {
      ...base,
      observations: [
        observation({ capturedAt: '2026-09-01T09:00:00Z' }),
        observation({ sessionId: 's2', evidenceId: 'e2', capturedAt: '2026-09-01T09:00:00Z' }),
      ],
    },
    'unapproved navigation': {
      ...base,
      navigationApproved: false,
      observations: [observation(), observation({ sessionId: 's2', evidenceId: 'e2' })],
    },
  };

  it.each(Object.entries(cases))('matches the reference for %s', (_name, input) => {
    expect(evaluateImportantLink(input as never)).toEqual(refDetector.evaluateImportantLink(input));
  });

  it('only a repeated identical failure produces a candidate, and it still needs review', () => {
    const result = evaluateImportantLink(cases['two independent 404s'] as never);
    expect(result.result).toBe('candidate');
    if (result.result !== 'candidate') throw new Error('unreachable');
    expect(result.requires_human_review).toBe(true);
    expect(result.proposed_grade).toBe('A');
    expect(result.limitations.length).toBeGreaterThan(0);
  });

  it('abstains rather than asserting a defect when a capture is ambiguous', () => {
    for (const name of ['challenge page', 'soft 404', 'mismatched status', 'single capture only']) {
      expect(evaluateImportantLink(cases[name] as never).result).toBe('unknown');
    }
  });
});
