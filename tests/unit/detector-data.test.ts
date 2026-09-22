import { describe, expect, it } from 'vitest';
import {
  DATA_DETECTOR_ID,
  DATA_DETECTOR_VERSION,
  evaluateStructuredData,
  type DataObservation,
  type StatedPrice,
} from '@oe/domain';

/**
 * CE-DATA-01, exhaustively — and mostly in the negative.
 *
 * `contracts/detectors.json` requires "visible and structured facts differ for matched
 * variant/currency/tax/stock state", abstaining on `variant_unknown`, `multi_currency`,
 * `aggregate_offer` and `unavailable_variant_context`. Each of those has a case here, and so
 * does every other way the rule declines.
 *
 * The bias worth naming: this rule is about prices, so a false positive tells a shop their
 * store contradicts itself when it does not. Every ambiguity therefore resolves to an
 * abstention, and the tests below are written to hold that line rather than to maximise
 * findings.
 */

const NOW = '2026-09-22T12:00:00Z';
const TARGET = 'https://shop.example.com/products/jacket';

function price(amountMinor: string, currency = 'EUR', taxBasis: StatedPrice['taxBasis'] = 'gross') {
  return { amountMinor, currency, taxBasis };
}

function observation(over: Partial<DataObservation> = {}): DataObservation {
  return {
    sessionId: 's1',
    evidenceId: 'e1',
    capturedAt: '2026-09-22T11:59:00Z',
    target: TARGET,
    contextKey: 'variant:med|1280x900|de-DE',
    structured: {
      offerKind: 'single',
      offerCount: 1,
      price: price('4900'),
      stock: 'in_stock',
      variantId: 'med',
    },
    visible: {
      price: price('4900'),
      stock: 'in_stock',
      variantId: 'med',
      currenciesSeen: ['EUR'],
    },
    pageComplete: true,
    challenge: false,
    loginWall: false,
    ...over,
  };
}

/** Two independent sessions of the same page, differing only in what a case is about. */
function pair(over: Partial<DataObservation> = {}): DataObservation[] {
  return [observation(over), observation({ ...over, sessionId: 's2', evidenceId: 'e2' })];
}

const run = (observations: DataObservation[], now = NOW) =>
  evaluateStructuredData({ target: TARGET, observations, now });

describe('the known positive', () => {
  it('reports a candidate when both sessions see the same price disagreement', () => {
    const result = run(
      pair({
        structured: {
          offerKind: 'single',
          offerCount: 1,
          price: price('4900'),
          stock: 'in_stock',
          variantId: 'med',
        },
        visible: {
          price: price('7900'),
          stock: 'in_stock',
          variantId: 'med',
          currenciesSeen: ['EUR'],
        },
      }),
    );
    expect(result.result).toBe('candidate');
    if (result.result !== 'candidate') throw new Error('unreachable');

    expect(result.reason).toBe('price_mismatch');
    expect(result.detector_id).toBe(DATA_DETECTOR_ID);
    expect(result.detector_version).toBe(DATA_DETECTOR_VERSION);
    expect(result.proposed_grade).toBe('A');
    expect(result.requires_human_review).toBe(true);
    expect(result.evidence_ids).toEqual(['e1', 'e2']);
    expect(result.claim).toContain('79.00 EUR');
    expect(result.claim).toContain('49.00 EUR');
  });

  it('says it does not know which figure is right', () => {
    // The most important thing a reviewer can be told about this rule, so it is asserted
    // rather than left to whoever writes the next limitation list.
    const result = run(
      pair({
        visible: {
          price: price('7900'),
          stock: 'in_stock',
          variantId: 'med',
          currenciesSeen: ['EUR'],
        },
      }),
    );
    if (result.result !== 'candidate') throw new Error('expected a candidate');
    expect(result.limitations[0]).toContain('does not establish which one is correct');
    expect(result.limitations.join(' ')).toContain('may intend either');
  });

  it('reports a stock disagreement as its own kind', () => {
    const result = run(
      pair({
        structured: {
          offerKind: 'single',
          offerCount: 1,
          price: price('4900'),
          stock: 'out_of_stock',
          variantId: 'med',
        },
      }),
    );
    if (result.result !== 'candidate') throw new Error('expected a candidate');
    expect(result.reason).toBe('stock_mismatch');
    expect(result.claim).toContain('out_of_stock');
  });
});

describe('the healthy negative', () => {
  it('reports no finding when the two statements match', () => {
    const result = run(pair());
    expect(result.result).toBe('no_finding');
    if (result.result !== 'no_finding') throw new Error('unreachable');
    expect(result.reason).toBe('visible_and_structured_facts_agree');
    // It says something about this sample, never about the store.
    expect(result.limitations.join(' ')).toContain('Nothing was established about any other');
  });
});

describe('the abstentions the contract names', () => {
  it('abstains on an aggregate offer, which has no single price to compare', () => {
    const result = run(
      pair({
        structured: {
          offerKind: 'aggregate',
          offerCount: 4,
          price: price('4900'),
          stock: 'in_stock',
          variantId: null,
        },
      }),
    );
    expect(result).toMatchObject({ result: 'unknown', reason: 'aggregate_offer' });
  });

  it('abstains when the page has no selected variant to match against', () => {
    // A page showing the small and marking up the medium is two facts about two things.
    const result = run(
      pair({
        visible: {
          price: price('7900'),
          stock: 'in_stock',
          variantId: null,
          currenciesSeen: ['EUR'],
        },
      }),
    );
    expect(result).toMatchObject({ result: 'unknown', reason: 'variant_unknown' });
  });

  it('does not compare the markup SKU to the page label, and says so in its limits', () => {
    // `JKT-MED-NAVY` against "Medium" is two naming systems, not a contradiction. A literal
    // comparison would abstain on almost every real page while catching almost nothing, so
    // this rule does not attempt it — and tells a reviewer that it did not.
    const result = run(
      pair({
        structured: {
          offerKind: 'single',
          offerCount: 1,
          price: price('7900'),
          stock: 'in_stock',
          variantId: 'JKT-MED-NAVY',
        },
      }),
    );
    expect(result.result).toBe('candidate');
    expect(result.limitations.join(' ')).toContain(
      'markup describes the same product variant the page displays was not verified',
    );
  });

  it('abstains when the two sessions saw different selected variants', () => {
    const [a, b] = pair();
    const moved = {
      ...b!,
      visible: { ...b!.visible, variantId: 'small' },
    };
    expect(run([a!, moved])).toMatchObject({
      result: 'unknown',
      reason: 'unavailable_variant_context',
    });
  });

  it('abstains when more than one currency is in view', () => {
    const result = run(
      pair({
        visible: {
          price: price('7900'),
          stock: 'in_stock',
          variantId: 'med',
          currenciesSeen: ['EUR', 'CHF'],
        },
      }),
    );
    expect(result).toMatchObject({ result: 'unknown', reason: 'multi_currency' });
  });

  it('abstains when the two sides are simply priced in different currencies', () => {
    // EUR 49 against USD 49 is two prices, not one number disagreeing.
    const result = run(
      pair({
        visible: {
          price: price('4900', 'USD'),
          stock: 'in_stock',
          variantId: 'med',
          currenciesSeen: ['USD'],
        },
      }),
    );
    expect(result).toMatchObject({ result: 'unknown', reason: 'multi_currency' });
  });
});

describe('tax, which is where this rule would otherwise be wrong most often', () => {
  it('abstains when a net figure beside a gross one could explain the gap', () => {
    // 49.00 net and 58.31 gross is 19% German VAT. The commonest legal arrangement in Europe,
    // and a rule that called it a defect would be wrong on a large share of real shops.
    const result = run(
      pair({
        structured: {
          offerKind: 'single',
          offerCount: 1,
          price: price('4900', 'EUR', 'net'),
          stock: 'in_stock',
          variantId: 'med',
        },
        visible: {
          price: price('5831', 'EUR', 'gross'),
          stock: 'in_stock',
          variantId: 'med',
          currenciesSeen: ['EUR'],
        },
      }),
    );
    expect(result).toMatchObject({
      result: 'unknown',
      reason: 'tax_basis_could_explain_difference',
    });
  });

  it('abstains when neither side says, and the gap is within a plausible rate', () => {
    const result = run(
      pair({
        structured: {
          offerKind: 'single',
          offerCount: 1,
          price: price('4900', 'EUR', 'unknown'),
          stock: 'in_stock',
          variantId: 'med',
        },
        visible: {
          price: price('5831', 'EUR', 'unknown'),
          stock: 'in_stock',
          variantId: 'med',
          currenciesSeen: ['EUR'],
        },
      }),
    );
    expect(result).toMatchObject({
      result: 'unknown',
      reason: 'tax_basis_could_explain_difference',
    });
  });

  it('still reports a gap no tax rate could explain', () => {
    // 49.00 against 79.00 is 61%. No EU member state has a rate that could produce it.
    const result = run(
      pair({
        structured: {
          offerKind: 'single',
          offerCount: 1,
          price: price('4900', 'EUR', 'unknown'),
          stock: 'in_stock',
          variantId: 'med',
        },
        visible: {
          price: price('7900', 'EUR', 'unknown'),
          stock: 'in_stock',
          variantId: 'med',
          currenciesSeen: ['EUR'],
        },
      }),
    );
    expect(result).toMatchObject({ result: 'candidate', reason: 'price_mismatch' });
  });

  it('reports a gap between two figures that both claim the same basis', () => {
    // Both declared gross and still different: whatever the ratio, that is a contradiction.
    const result = run(
      pair({
        structured: {
          offerKind: 'single',
          offerCount: 1,
          price: price('4900', 'EUR', 'gross'),
          stock: 'in_stock',
          variantId: 'med',
        },
        visible: {
          price: price('5000', 'EUR', 'gross'),
          stock: 'in_stock',
          variantId: 'med',
          currenciesSeen: ['EUR'],
        },
      }),
    );
    expect(result).toMatchObject({ result: 'candidate', reason: 'price_mismatch' });
  });

  it('holds the boundary at 27 per cent, the highest rate in the EU', () => {
    const at = (visibleMinor: string) =>
      run(
        pair({
          structured: {
            offerKind: 'single',
            offerCount: 1,
            price: price('10000', 'EUR', 'unknown'),
            stock: 'in_stock',
            variantId: 'med',
          },
          visible: {
            price: price(visibleMinor, 'EUR', 'unknown'),
            stock: 'in_stock',
            variantId: 'med',
            currenciesSeen: ['EUR'],
          },
        }),
      );
    // Exactly Hungary's rate: could be tax, so abstain.
    expect(at('12700').result).toBe('unknown');
    // A cent past it: nothing could explain it.
    expect(at('12701').result).toBe('candidate');
  });
});

describe('the abstentions every detector in this build shares', () => {
  it('abstains on one capture', () => {
    expect(run([observation()])).toMatchObject({
      result: 'unknown',
      reason: 'insufficient_independent_captures',
    });
  });

  it('abstains when both captures came from one session', () => {
    expect(run([observation(), observation({ evidenceId: 'e2' })])).toMatchObject({
      result: 'unknown',
      reason: 'insufficient_independent_captures',
    });
  });

  it('abstains when the two captures were of different page states', () => {
    const [a, b] = pair();
    expect(run([a!, { ...b!, contextKey: 'variant:small|1280x900|de-DE' }])).toMatchObject({
      result: 'unknown',
      reason: 'noncomparable_context',
    });
  });

  it('abstains on a challenge or a login wall', () => {
    expect(run(pair({ challenge: true }))).toMatchObject({ result: 'unknown', reason: 'blocked' });
    expect(run(pair({ loginWall: true }))).toMatchObject({ result: 'unknown', reason: 'blocked' });
  });

  it('abstains on an incomplete capture', () => {
    expect(run(pair({ pageComplete: false }))).toMatchObject({
      result: 'unknown',
      reason: 'incomplete_or_ambiguous_capture',
    });
  });

  it('abstains on evidence older than the freshness policy, and on a future capture', () => {
    expect(run(pair({ capturedAt: '2026-08-01T00:00:00Z' }))).toMatchObject({
      result: 'unknown',
      reason: 'stale_or_future_capture',
    });
    expect(run(pair({ capturedAt: '2026-12-01T00:00:00Z' }))).toMatchObject({
      result: 'unknown',
      reason: 'stale_or_future_capture',
    });
  });

  it('abstains when a page carries no structured product data at all', () => {
    // Nothing to compare is not a defect. Plenty of shops have no markup.
    const result = run(
      pair({
        structured: { offerKind: 'none', offerCount: 0, price: null, stock: null, variantId: null },
      }),
    );
    expect(result).toMatchObject({ result: 'unknown', reason: 'structured_data_absent' });
  });

  it('abstains when only one side states a price', () => {
    const result = run(
      pair({
        visible: { price: null, stock: 'in_stock', variantId: 'med', currenciesSeen: [] },
      }),
    );
    expect(result).toMatchObject({ result: 'unknown', reason: 'visible_facts_not_established' });
  });

  it('abstains when the two sessions disagree about what disagreed', () => {
    // Two observations of different things are not two observations of one defect.
    const [a] = pair();
    const b = observation({
      sessionId: 's2',
      evidenceId: 'e2',
      structured: {
        offerKind: 'single',
        offerCount: 1,
        price: price('4900'),
        stock: 'out_of_stock',
        variantId: 'med',
      },
    });
    const priced = observation({
      ...a!,
      visible: {
        price: price('9900'),
        stock: 'in_stock',
        variantId: 'med',
        currenciesSeen: ['EUR'],
      },
    });
    expect(run([priced, b])).toMatchObject({
      result: 'unknown',
      reason: 'inconsistent_difference',
    });
  });

  it('refuses a malformed record rather than guessing at it', () => {
    expect(evaluateStructuredData({ target: '', observations: pair(), now: NOW })).toMatchObject({
      result: 'unknown',
      reason: 'invalid_capture_record',
    });
    const [a, b] = pair();
    expect(run([a!, { ...b!, target: 'https://elsewhere.example.com/p' }])).toMatchObject({
      result: 'unknown',
      reason: 'invalid_capture_record',
    });
    expect(run(pair(), 'not-a-date')).toMatchObject({
      result: 'unknown',
      reason: 'invalid_freshness_policy',
    });
  });

  it('never proposes a grade or a claim when it abstains', () => {
    // A shape assertion, because an abstention that carried a claim would be read as one.
    const result = run(pair({ challenge: true }));
    expect(result.proposed_grade).toBeNull();
    expect(Object.keys(result)).not.toContain('claim');
    expect(Object.keys(result)).not.toContain('detector_id');
  });
});

describe('when only one side says whether it is in stock', () => {
  it('names that as its own reason rather than a variant problem', () => {
    // A reader deserves to know which of the two sides went quiet. Lumping this in with
    // `unavailable_variant_context` would send somebody looking at the wrong thing.
    const result = run(
      pair({
        visible: { price: price('4900'), stock: null, variantId: 'med', currenciesSeen: ['EUR'] },
      }),
    );
    expect(result).toMatchObject({ result: 'unknown', reason: 'stock_not_stated' });
  });

  it('does not reach the stock check at all when the prices already disagree', () => {
    // A price contradiction is the finding; whether availability was also stated is beside
    // the point, and abstaining on it would swallow a real one.
    const result = run(
      pair({
        visible: { price: price('9900'), stock: null, variantId: 'med', currenciesSeen: ['EUR'] },
      }),
    );
    expect(result).toMatchObject({ result: 'candidate', reason: 'price_mismatch' });
  });
});
