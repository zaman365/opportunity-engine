/**
 * CE-DATA-01 · the page says one price, its structured data says another.
 *
 * Named `MF-DATA-01` in the handoff contract; `@oe/contracts/detector-ids.ts` maps the old
 * spelling onto this one.
 *
 * `contracts/detectors.json` fixes the bar: "Visible and structured facts differ for matched
 * variant/currency/tax/stock state", abstaining on `variant_unknown`, `multi_currency`,
 * `aggregate_offer` and `unavailable_variant_context`.
 *
 * Every word of "for matched variant/currency/tax/stock state" is load-bearing, and each one
 * is a way this rule would otherwise produce a false positive:
 *
 * - **Variant.** Without a known selected variant there is nothing to match, so the rule needs
 *   one and needs both sessions to have seen the same one. It does not try to match the
 *   markup's SKU to the page's visible label: those are two naming systems, and comparing
 *   them literally would abstain on almost every real page. A page marking up a different
 *   variant from the one it displays is therefore outside what this rule detects.
 * - **Currency.** EUR 49 and USD 49 are not the same number disagreeing, they are two prices.
 * - **Tax.** A net figure in markup beside a gross figure on the page is the commonest legal
 *   arrangement in Europe, not a defect. So a difference is only a candidate when both sides
 *   state the same tax basis, or neither states one and the amounts still differ by more than
 *   any plausible VAT rate could explain.
 * - **Stock.** "In stock" against `OutOfStock` is a real contradiction; "in stock" against a
 *   page that never said is not.
 *
 * And an `AggregateOffer` — a range across variants — has no single price to compare at all.
 *
 * Deterministic: fetches nothing, renders nothing, approves nothing. A candidate still needs a
 * reviewer, exactly as for CE-LINK-01 and CE-ASSET-01.
 */

export const DATA_DETECTOR_ID = 'CE-DATA-01';
export const DATA_DETECTOR_VERSION = '1.0.0';

export type StockState = 'in_stock' | 'out_of_stock' | 'preorder' | 'discontinued';

/** How a price is stated with respect to tax. `unknown` is the common and honest case. */
export type TaxBasis = 'gross' | 'net' | 'unknown';

/** A price as one side of the page stated it. Minor units, so nothing passes through a float. */
export interface StatedPrice {
  amountMinor: string;
  currency: string;
  taxBasis: TaxBasis;
}

/** What the page's structured data (JSON-LD, microdata) declared. */
export interface StructuredFacts {
  /** `single` when exactly one Offer was found; `aggregate` for a range; `none` for neither. */
  offerKind: 'single' | 'aggregate' | 'none';
  offerCount: number;
  price: StatedPrice | null;
  stock: StockState | null;
  /** The variant the markup is about, if it names one. */
  variantId: string | null;
}

/** What a person reading the rendered page would have seen. */
export interface VisibleFacts {
  price: StatedPrice | null;
  stock: StockState | null;
  /** The variant the page had selected when it was captured. */
  variantId: string | null;
  /** Distinct currencies visible anywhere in the price area. More than one is ambiguous. */
  currenciesSeen: string[];
}

export interface DataObservation {
  sessionId: string;
  evidenceId: string;
  capturedAt: string;
  /** The page under test. Every observation must name the same one. */
  target: string;
  /** Variant, viewport and locale. Two observations must share it to be comparable. */
  contextKey: string;
  structured: StructuredFacts;
  visible: VisibleFacts;
  pageComplete: boolean;
  challenge: boolean;
  loginWall: boolean;
}

export interface DataDetectorInput {
  target: string;
  observations: DataObservation[];
  now: string;
  maxAgeMs?: number;
}

export type DataAbstention =
  | 'insufficient_independent_captures'
  | 'invalid_capture_record'
  | 'incomplete_or_ambiguous_capture'
  | 'blocked'
  | 'variant_unknown'
  | 'multi_currency'
  | 'aggregate_offer'
  | 'unavailable_variant_context'
  | 'structured_data_absent'
  | 'visible_facts_not_established'
  | 'stock_not_stated'
  | 'tax_basis_could_explain_difference'
  | 'noncomparable_context'
  | 'stale_or_future_capture'
  | 'invalid_freshness_policy'
  | 'inconsistent_difference';

/** What disagreed. Recorded so a repair has somewhere to start. */
export type DataMismatchKind = 'price_mismatch' | 'stock_mismatch';

export type DataDetectorResult =
  | {
      result: 'unknown';
      reason: DataAbstention;
      evidence_ids: string[];
      proposed_grade: null;
      limitations: string[];
    }
  | {
      result: 'no_finding';
      reason: 'visible_and_structured_facts_agree';
      evidence_ids: string[];
      proposed_grade: null;
      limitations: string[];
    }
  | {
      result: 'candidate';
      reason: DataMismatchKind;
      detector_id: string;
      detector_version: string;
      claim: string;
      evidence_ids: string[];
      proposed_grade: 'A';
      requires_human_review: true;
      limitations: string[];
    };

const BASE_LIMITATIONS = [
  'Only the product state captured — this variant, currency and viewport — was compared.',
  'Whether a shopper or a search engine acted on either figure is unknown.',
  'Store-wide scope and revenue impact are unknown.',
];

const abstain = (reason: DataAbstention, evidenceIds: string[] = []): DataDetectorResult => ({
  result: 'unknown',
  reason,
  evidence_ids: evidenceIds,
  proposed_grade: null,
  limitations: [
    'This rule compares two statements on one page. It does not establish which is correct.',
    ...BASE_LIMITATIONS,
  ],
});

/**
 * The highest VAT rate any EU member state applies, as a multiplier.
 *
 * Used only to decide whether an unexplained gap *could* be tax. Hungary's 27% is the ceiling;
 * a difference larger than that cannot be a tax basis mismatch, and a smaller one might be, so
 * the rule abstains on it rather than guessing. Being wrong in this direction costs a finding;
 * being wrong in the other costs a customer being told their prices contradict when they do
 * not.
 */
const MAX_PLAUSIBLE_VAT_MULTIPLIER = 1.27;

function isFiniteMinor(value: string): boolean {
  return /^\d{1,18}$/.test(value);
}

function samePrice(a: StatedPrice, b: StatedPrice): boolean {
  return a.currency === b.currency && BigInt(a.amountMinor) === BigInt(b.amountMinor);
}

/**
 * Could a tax basis difference explain this gap?
 *
 * Only when the two sides state different bases, or at least one does not say. Two prices both
 * declared gross that differ are a real contradiction whatever the ratio.
 */
function taxCouldExplain(a: StatedPrice, b: StatedPrice): boolean {
  if (a.taxBasis === b.taxBasis && a.taxBasis !== 'unknown') return false;
  const low = Number(BigInt(a.amountMinor) < BigInt(b.amountMinor) ? a.amountMinor : b.amountMinor);
  const high = Number(
    BigInt(a.amountMinor) < BigInt(b.amountMinor) ? b.amountMinor : a.amountMinor,
  );
  if (low <= 0) return false;
  return high / low <= MAX_PLAUSIBLE_VAT_MULTIPLIER;
}

export function evaluateStructuredData(input: DataDetectorInput): DataDetectorResult {
  if (!input || typeof input.target !== 'string' || !input.target.trim()) {
    return abstain('invalid_capture_record');
  }
  if (!Array.isArray(input.observations) || input.observations.length < 2) {
    return abstain('insufficient_independent_captures');
  }
  const obs = input.observations;

  if (obs.some((o) => !o || typeof o.sessionId !== 'string' || typeof o.evidenceId !== 'string')) {
    return abstain('invalid_capture_record');
  }
  if (obs.some((o) => o.target !== input.target)) return abstain('invalid_capture_record');

  const evidenceIds = obs.map((o) => o.evidenceId);

  // Two captures from one session are one observation recorded twice.
  if (new Set(obs.map((o) => o.sessionId)).size < 2) {
    return abstain('insufficient_independent_captures');
  }
  if (new Set(obs.map((o) => o.contextKey)).size !== 1) {
    return abstain('noncomparable_context', evidenceIds);
  }
  if (obs.some((o) => o.challenge || o.loginWall)) return abstain('blocked', evidenceIds);
  if (obs.some((o) => !o.pageComplete)) {
    return abstain('incomplete_or_ambiguous_capture', evidenceIds);
  }

  const maxAgeMs = input.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return abstain('invalid_freshness_policy');
  const now = Date.parse(input.now);
  if (Number.isNaN(now)) return abstain('invalid_freshness_policy');
  for (const o of obs) {
    const at = Date.parse(o.capturedAt);
    if (Number.isNaN(at) || at > now || now - at > maxAgeMs) {
      return abstain('stale_or_future_capture', evidenceIds);
    }
  }

  // A range across variants has no single price to compare against anything.
  if (obs.some((o) => o.structured.offerKind === 'aggregate' || o.structured.offerCount > 1)) {
    return abstain('aggregate_offer', evidenceIds);
  }
  if (obs.some((o) => o.structured.offerKind === 'none')) {
    return abstain('structured_data_absent', evidenceIds);
  }

  // Without a known selected variant there is nothing to match the markup against: a page
  // showing the small and marking up the medium is two facts about two things.
  if (obs.some((o) => o.visible.variantId === null)) {
    return abstain('variant_unknown', evidenceIds);
  }
  if (new Set(obs.map((o) => o.visible.variantId)).size !== 1) {
    return abstain('unavailable_variant_context', evidenceIds);
  }
  // The markup's SKU and the page's visible variant label are deliberately NOT compared.
  //
  // They are two different naming systems — `JKT-MED-NAVY` against "Medium" — and a literal
  // comparison would abstain on almost every real page while catching almost nothing. What
  // matters for comparability is already established above: a variant is selected, and both
  // sessions saw the same one. A page whose markup describes a different variant from the one
  // it displays is a defect this rule does not detect, and that is written into its
  // limitations rather than papered over with a string match that does not work.

  // More than one currency in view is ambiguity, not a contradiction.
  if (obs.some((o) => new Set(o.visible.currenciesSeen).size > 1)) {
    return abstain('multi_currency', evidenceIds);
  }

  const kinds = new Set<DataMismatchKind | 'agree'>();
  for (const o of obs) {
    const structured = o.structured.price;
    const visible = o.visible.price;

    if (structured !== null && visible !== null) {
      if (!isFiniteMinor(structured.amountMinor) || !isFiniteMinor(visible.amountMinor)) {
        return abstain('invalid_capture_record', evidenceIds);
      }
      if (structured.currency !== visible.currency) {
        return abstain('multi_currency', evidenceIds);
      }
      if (!samePrice(structured, visible)) {
        // Net beside gross is the commonest legal arrangement in Europe, not a defect.
        if (taxCouldExplain(structured, visible)) {
          return abstain('tax_basis_could_explain_difference', evidenceIds);
        }
        kinds.add('price_mismatch');
        continue;
      }
    } else if (structured !== null || visible !== null) {
      // One side states a price and the other does not. That is a gap in what could be
      // compared, not evidence that either is wrong.
      return abstain('visible_facts_not_established', evidenceIds);
    }

    if (o.structured.stock !== null && o.visible.stock !== null) {
      if (o.structured.stock !== o.visible.stock) {
        kinds.add('stock_mismatch');
        continue;
      }
    } else if (o.structured.stock !== null || o.visible.stock !== null) {
      // A page that never says whether something is in stock is not contradicting its markup.
      // Its own reason rather than `unavailable_variant_context`: a reader deserves to know
      // which of the two sides went quiet, and lumping it in with a variant problem would
      // send somebody looking at the wrong thing.
      return abstain('stock_not_stated', evidenceIds);
    }

    kinds.add('agree');
  }

  // Sessions that disagree about *what* disagreed are not two observations of one defect.
  if (kinds.size !== 1) return abstain('inconsistent_difference', evidenceIds);
  const only = [...kinds][0]!;

  if (only === 'agree') {
    return {
      result: 'no_finding',
      reason: 'visible_and_structured_facts_agree',
      evidence_ids: evidenceIds,
      proposed_grade: null,
      limitations: [
        'The two statements matched in the recorded checks. Nothing was established about any other variant or page.',
        ...BASE_LIMITATIONS,
      ],
    };
  }

  const first = obs[0]!;
  const claim =
    only === 'price_mismatch'
      ? `The page and its structured data state different prices for the same product state in ${obs.length} recorded checks: ${formatStated(first.visible.price!)} on the page, ${formatStated(first.structured.price!)} in the markup.`
      : `The page and its structured data state different availability for the same product state in ${obs.length} recorded checks: ${first.visible.stock} on the page, ${first.structured.stock} in the markup.`;

  return {
    result: 'candidate',
    reason: only,
    detector_id: DATA_DETECTOR_ID,
    detector_version: DATA_DETECTOR_VERSION,
    claim,
    evidence_ids: evidenceIds,
    proposed_grade: 'A',
    requires_human_review: true,
    limitations: [
      // The most important thing a reviewer can be told about this rule.
      'This says the two statements disagree. It does not establish which one is correct, and the shop may intend either.',
      'Whether the markup describes the same product variant the page displays was not verified.',
      'A shopping feed or a search engine may use either figure; which, and whether it did, was not tested.',
      ...BASE_LIMITATIONS,
    ],
  };
}

function formatStated(price: StatedPrice): string {
  const value = BigInt(price.amountMinor);
  const amount = `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
  const basis = price.taxBasis === 'unknown' ? '' : ` ${price.taxBasis}`;
  return `${amount} ${price.currency}${basis}`;
}
