import { describe, expect, it } from 'vitest';
import {
  effortBand,
  formatMinor,
  matchOffers,
  mergeOfferCatalog,
  nextActionForCase,
  type CatalogOffer,
  type MatchInput,
} from '@oe/domain';

/**
 * The matcher is the step between a confirmed finding and a price put in front of somebody.
 *
 * BUILD_SPEC.md §9: "Price/scope from catalog, not free generation." Most of what follows is
 * negative: the cases where this code must refuse. A matcher that is merely permissive would
 * pass a happy-path test and still quote work nobody approved.
 */

const REPAIR: CatalogOffer = {
  id: '00000000-0000-4000-8000-000000000001',
  sku: 'MF-LINK-REPAIR',
  version: 1,
  promise: 'Repair one supported information-link root cause.',
  detectorFamilies: ['MF-LINK-01'],
  inclusions: ['one agreed link/route family'],
  exclusions: ['whole-site redesign'],
  prerequisites: ['authorized code/platform access', 'agreed destination'],
  acceptance: ['approved destination loads in recorded conditions'],
  currency: 'EUR',
  priceMinor: '29000',
  taxTreatment: 'net',
  minEffortMinutes: 60,
  maxEffortMinutes: 180,
  enabled: true,
};

function input(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    confirmedFindings: [{ id: 'f1', detectorId: 'MF-LINK-01', rootCauseKey: 'size-guide-404' }],
    catalog: [REPAIR],
    satisfiedPrerequisites: REPAIR.prerequisites,
    openCommitments: 0,
    deliveryCapacity: 3,
    ...overrides,
  };
}

describe('matchOffers', () => {
  it('matches a confirmed finding to the SKU whose family covers its detector', () => {
    const result = matchOffers(input());
    expect(result.eligible).toHaveLength(1);
    expect(result.eligible[0]!.offer.sku).toBe('MF-LINK-REPAIR');
    expect(result.eligible[0]!.draftable).toBe(true);
    expect(result.routeToManualQuotation).toBe(false);
  });

  it('refuses a SKU with no approved price, even when it is enabled', () => {
    // The pair that matters. A scope with no price is not sellable however keen anyone is.
    const result = matchOffers(
      input({ catalog: [{ ...REPAIR, priceMinor: null, currency: null }] }),
    );
    expect(result.eligible).toEqual([]);
    expect(result.rejected).toEqual([
      { sku: 'MF-LINK-REPAIR', reason: 'sku_has_no_approved_price' },
    ]);
    expect(result.routeToManualQuotation).toBe(true);
  });

  it('refuses a priced SKU the owner has not enabled', () => {
    const result = matchOffers(input({ catalog: [{ ...REPAIR, enabled: false }] }));
    expect(result.rejected).toEqual([{ sku: 'MF-LINK-REPAIR', reason: 'sku_not_enabled' }]);
  });

  it('ignores the catalogue entirely when nothing is confirmed', () => {
    // A candidate is a question. Quoting one would be selling work nobody stood behind.
    const result = matchOffers(input({ confirmedFindings: [] }));
    expect(result.eligible).toEqual([]);
    expect(result.rejected).toEqual([{ sku: 'MF-LINK-REPAIR', reason: 'no_confirmed_finding' }]);
    // Not a quotation conversation either: there is nothing to quote about yet.
    expect(result.routeToManualQuotation).toBe(false);
  });

  it('routes to manual quotation when a confirmed detector has no SKU', () => {
    const result = matchOffers(
      input({
        confirmedFindings: [{ id: 'f9', detectorId: 'MF-DATA-01', rootCauseKey: 'feed-drift' }],
      }),
    );
    expect(result.routeToManualQuotation).toBe(true);
    expect(result.rejected).toEqual([
      { sku: 'MF-LINK-REPAIR', reason: 'detector_not_supported_by_any_sku' },
    ]);
  });

  it('keeps an offer eligible but not draftable while a prerequisite is unrecorded', () => {
    const result = matchOffers(input({ satisfiedPrerequisites: ['agreed destination'] }));
    expect(result.eligible).toHaveLength(1);
    expect(result.eligible[0]!.unmetPrerequisites).toEqual(['authorized code/platform access']);
    expect(result.eligible[0]!.draftable).toBe(false);
    // Visible with its reason, not silently dropped: the operator needs to know what to fix.
    expect(result.rejected).toEqual([{ sku: 'MF-LINK-REPAIR', reason: 'prerequisites_unmet' }]);
  });

  it('stops drafting when delivery capacity is fully committed', () => {
    const result = matchOffers(input({ openCommitments: 3, deliveryCapacity: 3 }));
    expect(result.capacityReached).toBe(true);
    expect(result.eligible[0]!.draftable).toBe(false);
    expect(result.rejected).toEqual([
      { sku: 'MF-LINK-REPAIR', reason: 'delivery_capacity_reached' },
    ]);
  });

  it('treats a zero capacity as a refusal rather than as no limit', () => {
    const result = matchOffers(input({ openCommitments: 0, deliveryCapacity: 0 }));
    expect(result.capacityReached).toBe(true);
    expect(result.eligible[0]!.draftable).toBe(false);
  });

  it('counts one root cause once, however many findings carry it', () => {
    // The same template defect found on three pages is one job, not three.
    const result = matchOffers(
      input({
        confirmedFindings: [
          { id: 'f1', detectorId: 'MF-LINK-01', rootCauseKey: 'size-guide-404' },
          { id: 'f2', detectorId: 'MF-LINK-01', rootCauseKey: 'size-guide-404' },
          { id: 'f3', detectorId: 'MF-LINK-01', rootCauseKey: 'care-guide-410' },
        ],
      }),
    );
    expect(result.eligible[0]!.findingIds).toEqual(['f1', 'f2', 'f3']);
    expect(result.eligible[0]!.rootCauseKeys).toEqual(['care-guide-410', 'size-guide-404']);
  });
});

describe('formatMinor', () => {
  it('formats minor units without touching a float', () => {
    expect(formatMinor('29000', 'EUR')).toBe('290.00 EUR');
    expect(formatMinor('19050', 'EUR')).toBe('190.50 EUR');
    expect(formatMinor('5', 'EUR')).toBe('0.05 EUR');
    expect(formatMinor('0', 'EUR')).toBe('0.00 EUR');
  });

  it('stays exact past the range where a float would not be', () => {
    expect(formatMinor('9007199254740993', 'EUR')).toBe('90071992547409.93 EUR');
  });
});

describe('effortBand', () => {
  it('states a range rather than a single number', () => {
    expect(effortBand(REPAIR)).toBe('1–3 h');
    expect(effortBand({ ...REPAIR, minEffortMinutes: 45, maxEffortMinutes: 75 })).toBe('0.8–1.3 h');
    expect(effortBand({ ...REPAIR, minEffortMinutes: 60, maxEffortMinutes: 60 })).toBe('1 h');
  });

  it('says nothing rather than guessing when no estimate was approved', () => {
    expect(effortBand({ ...REPAIR, minEffortMinutes: null })).toBeNull();
  });
});

describe('mergeOfferCatalog', () => {
  const catalog = {
    offers: [
      {
        sku: 'MF-LINK-REPAIR',
        version: 1,
        venture: 'marktfix',
        promise: 'Repair one supported information-link root cause.',
        detectors: ['MF-LINK-01'],
        inclusions: ['one agreed link/route family'],
        exclusions: ['whole-site redesign'],
        prerequisites: ['authorized code/platform access'],
        acceptance: ['approved destination loads'],
        currency: 'EUR',
        price_minor: null,
      },
    ],
  };
  const approval = {
    sku: 'MF-LINK-REPAIR',
    version: 1,
    enabled: true,
    currency: 'EUR',
    price_minor: '29000',
    tax_treatment: 'net',
    min_effort_minutes: 60,
    max_effort_minutes: 180,
    approved_by_subject: 'owner@fixture.test',
    approved_at: '2026-09-21T00:00:00Z',
  };

  it('carries scope from the catalogue and price from the approval', () => {
    const { offers, problems } = mergeOfferCatalog(catalog, { approvals: [approval] });
    expect(problems).toEqual([]);
    expect(offers[0]).toMatchObject({
      sku: 'MF-LINK-REPAIR',
      venture: 'marktfix',
      priceMinor: '29000',
      enabled: true,
      approvedBySubject: 'owner@fixture.test',
    });
  });

  it('leaves an unapproved SKU disabled and unpriced without complaining', () => {
    // The state the kit ships in. Not an error — just not for sale.
    const { offers, problems } = mergeOfferCatalog(catalog, { approvals: [] });
    expect(problems).toEqual([]);
    expect(offers[0]).toMatchObject({ enabled: false, priceMinor: null, currency: null });
  });

  it('refuses to enable a SKU whose approval has no price', () => {
    const { problems } = mergeOfferCatalog(catalog, {
      approvals: [{ ...approval, price_minor: null }],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('enabled requires an approved price');
  });

  it('refuses to enable a SKU whose approval names nobody', () => {
    const { problems } = mergeOfferCatalog(catalog, {
      approvals: [{ ...approval, approved_by_subject: null }],
    });
    expect(problems[0]).toContain('enabled requires an approved price');
  });

  it('rejects a price that is not integer minor units', () => {
    // "290.00" would be read as 290 cents by anything that parsed it loosely.
    for (const bad of ['290.00', '29_000', 290, '-1']) {
      const { problems } = mergeOfferCatalog(catalog, {
        approvals: [{ ...approval, price_minor: bad }],
      });
      expect(problems.join(' '), String(bad)).toContain('minor units');
    }
  });

  it('refuses an approval whose currency contradicts the catalogue', () => {
    const { problems } = mergeOfferCatalog(catalog, {
      approvals: [{ ...approval, currency: 'USD' }],
    });
    expect(problems.join(' ')).toContain('contradicts catalogue currency');
  });

  it('does not let an approval follow a scope to a new version', () => {
    // The scope changed; the price nobody re-approved must not carry over to it.
    const moved = { offers: [{ ...catalog.offers[0]!, version: 2 }] };
    const { offers, problems } = mergeOfferCatalog(moved, { approvals: [approval] });
    expect(offers[0]).toMatchObject({ version: 2, enabled: false, priceMinor: null });
    expect(problems.join(' ')).toContain('matches no catalogue entry at that version');
  });

  it('rejects an effort band that runs backwards', () => {
    const { problems } = mergeOfferCatalog(catalog, {
      approvals: [{ ...approval, min_effort_minutes: 180, max_effort_minutes: 60 }],
    });
    expect(problems.join(' ')).toContain('below');
  });
});

/**
 * What a case is waiting on.
 *
 * One rule, two writers — the runner when a scan adds a finding, the review service when a
 * reviewer decides one. The cases below are the ones where those two would otherwise have
 * drifted apart.
 */
describe('nextActionForCase', () => {
  const at = (findingStates: string[], current = 'review_evidence') =>
    nextActionForCase({ findingStates, current });

  it('waits for review while anything is undecided', () => {
    expect(at(['candidate'])).toBe('review_evidence');
    expect(at(['confirmed', 'candidate'], 'draft_offer')).toBe('review_evidence');
    // A confirmed claim that went stale is undecided again, not settled.
    expect(at(['stale'], 'draft_offer')).toBe('review_evidence');
  });

  it('moves to drafting only once nothing is outstanding', () => {
    expect(at(['confirmed'])).toBe('draft_offer');
    expect(at(['confirmed', 'rejected'])).toBe('draft_offer');
  });

  it('asks for revalidation when nothing was true this time', () => {
    // Not `none`: a case where every claim was rejected is a reason to look again later.
    expect(at(['rejected'])).toBe('revalidate');
    expect(at(['rejected', 'unknown'])).toBe('revalidate');
  });

  it('never overwrites a permission fact with a workflow guess', () => {
    // Nothing about findings can establish that somebody asked for access.
    expect(at(['confirmed'], 'request_access')).toBe('request_access');
    expect(at(['candidate'], 'request_access')).toBe('request_access');
  });

  it('says nothing about a case with no findings at all', () => {
    expect(at([], 'none')).toBe('none');
  });
});
