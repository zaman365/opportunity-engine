/**
 * Which service scopes a confirmed finding is eligible for.
 *
 * BUILD_SPEC.md §9: "Offer matcher · Rule-based catalog plus LLM explanation · Verified need +
 * prerequisites → eligible offer draft · **Price/scope from catalog, not free generation.**"
 *
 * So this is deterministic. It selects from a catalogue an owner approved; it never invents a
 * price, never widens a scope, and never decides that unsupported work is supportable. When
 * nothing fits it says so and routes to manual quotation, which is a real answer rather than a
 * failure.
 */

import { sameDetector } from '@oe/contracts';

export type OfferIneligibility =
  | 'no_confirmed_finding'
  | 'detector_not_supported_by_any_sku'
  | 'sku_not_enabled'
  | 'sku_has_no_approved_price'
  | 'prerequisites_unmet'
  | 'delivery_capacity_reached';

/** A catalogue entry, as the owner approved it. */
export interface CatalogOffer {
  id: string;
  sku: string;
  version: number;
  promise: string;
  /** Detector IDs whose findings this scope can answer. */
  detectorFamilies: string[];
  inclusions: string[];
  exclusions: string[];
  /** Conditions that must hold before the work can start. */
  prerequisites: string[];
  acceptance: string[];
  currency: string | null;
  /** Minor units (cents). Null until an owner approves a price. */
  priceMinor: string | null;
  taxTreatment: string | null;
  minEffortMinutes: number | null;
  maxEffortMinutes: number | null;
  enabled: boolean;
}

/** What the engine knows about the case a scope would be drafted for. */
export interface MatchInput {
  /** Confirmed findings only. A candidate is not a need. */
  confirmedFindings: { id: string; detectorId: string; rootCauseKey: string }[];
  catalog: CatalogOffer[];
  /** Prerequisites the operator has recorded as satisfied for this account. */
  satisfiedPrerequisites: string[];
  /** Drafts and engagements already open. Offers consume delivery hours, not just compute. */
  openCommitments: number;
  deliveryCapacity: number;
}

export interface EligibleOffer {
  offer: CatalogOffer;
  /** The confirmed findings this scope would answer. */
  findingIds: string[];
  /** Root causes covered, deduplicated. One template defect is one job, not many. */
  rootCauseKeys: string[];
  /** Still outstanding. An eligible offer with unmet prerequisites cannot be drafted yet. */
  unmetPrerequisites: string[];
  draftable: boolean;
}

export interface MatchResult {
  eligible: EligibleOffer[];
  /** Why each catalogue entry was not eligible. Shown to the operator, not swallowed. */
  rejected: { sku: string; reason: OfferIneligibility }[];
  /**
   * True when confirmed findings exist but no catalogue scope covers them. BUILD_SPEC.md:
   * "unsupported scope routes to diagnosis or manual quotation."
   */
  routeToManualQuotation: boolean;
  capacityReached: boolean;
}

export function matchOffers(input: MatchInput): MatchResult {
  const rejected: { sku: string; reason: OfferIneligibility }[] = [];
  const capacityReached = input.openCommitments >= input.deliveryCapacity;

  if (input.confirmedFindings.length === 0) {
    return {
      eligible: [],
      rejected: input.catalog.map((offer) => ({
        sku: offer.sku,
        reason: 'no_confirmed_finding' as const,
      })),
      routeToManualQuotation: false,
      capacityReached,
    };
  }

  const eligible: EligibleOffer[] = [];

  for (const offer of input.catalog) {
    // Compared canonically. A catalogue entry written against the handoff namespace
    // (`MF-LINK-01`) and a finding produced under the engine's own (`CE-LINK-01`) name the
    // same rule, and a scope that stopped matching because a namespace moved would silently
    // route real work to manual quotation.
    const findings = input.confirmedFindings.filter((finding) =>
      offer.detectorFamilies.some((family) => sameDetector(family, finding.detectorId)),
    );
    if (findings.length === 0) {
      rejected.push({ sku: offer.sku, reason: 'detector_not_supported_by_any_sku' });
      continue;
    }
    // An owner has to have both enabled the SKU and approved a price. Either alone is not
    // permission to quote: a scope with no price cannot be offered, and a priced scope the
    // owner has not enabled is not for sale yet.
    if (!offer.enabled) {
      rejected.push({ sku: offer.sku, reason: 'sku_not_enabled' });
      continue;
    }
    if (offer.priceMinor === null || offer.currency === null) {
      rejected.push({ sku: offer.sku, reason: 'sku_has_no_approved_price' });
      continue;
    }

    const unmet = offer.prerequisites.filter(
      (prerequisite) => !input.satisfiedPrerequisites.includes(prerequisite),
    );
    // Root causes, not findings: the same template defect found twice is one job.
    const rootCauseKeys = [...new Set(findings.map((finding) => finding.rootCauseKey))].sort();

    eligible.push({
      offer,
      findingIds: findings.map((finding) => finding.id),
      rootCauseKeys,
      unmetPrerequisites: unmet,
      draftable: unmet.length === 0 && !capacityReached,
    });
    if (unmet.length > 0) rejected.push({ sku: offer.sku, reason: 'prerequisites_unmet' });
    else if (capacityReached)
      rejected.push({ sku: offer.sku, reason: 'delivery_capacity_reached' });
  }

  return {
    eligible,
    rejected,
    // Confirmed work exists and the catalogue has nothing for it. That is a quotation
    // conversation, not an error and not a reason to stretch an existing SKU.
    routeToManualQuotation: eligible.length === 0,
    capacityReached,
  };
}

/**
 * Money in minor units, as the catalogue stores it.
 *
 * Commercial prices are EUR minor units and provider costs are USD micro-units; they are
 * different scales on purpose and BUDGET_LEDGER.md forbids adding them. Keeping the two in
 * separate helpers makes mixing them a type error rather than an arithmetic one.
 */
export function formatMinor(priceMinor: string, currency: string): string {
  const value = BigInt(priceMinor);
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction} ${currency}`;
}

/**
 * The estimated effort band, stated as a range.
 *
 * A single number would imply a precision nobody has. The pricing analysis assumed 1–3 hours
 * for a repair; the catalogue carries that band so a quote can show it rather than hide it.
 */
export function effortBand(offer: CatalogOffer): string | null {
  if (offer.minEffortMinutes === null || offer.maxEffortMinutes === null) return null;
  const hours = (minutes: number) => (minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1);
  return offer.minEffortMinutes === offer.maxEffortMinutes
    ? `${hours(offer.minEffortMinutes)} h`
    : `${hours(offer.minEffortMinutes)}–${hours(offer.maxEffortMinutes)} h`;
}
