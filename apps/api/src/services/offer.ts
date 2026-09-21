import type { CreateOfferDraft, OfferMatch, WithdrawOfferDraft } from '@oe/contracts';
import { matchOffers } from '@oe/domain';
import {
  countOpenCommitments,
  getDeliveryCapacity,
  getFinding,
  getOffer,
  getOpportunity,
  insertAuditEvent,
  insertOfferDraft,
  listCurrentOffers,
  listOfferPrerequisites,
  withdrawOfferDraft,
  type OfferDraftRow,
  type QueryExecutor,
} from '@oe/db';
import { ApiProblem } from '../problem.ts';
import type { AppDependencies, RequestActor } from '../context.ts';
import { toCatalogOffer, toOffer } from '../projections.ts';

/**
 * The catalogue step: from a confirmed finding to a scope with an approved price.
 *
 * BUILD_SPEC.md §9: "Verified need + prerequisites → eligible offer draft. Price/scope from
 * catalog, not free generation." Everything here is arithmetic over rows an owner approved.
 * Nothing in this file can produce a price, widen a scope, or turn an unsupported detector
 * into supported work — those would all be ways of inventing a promise to a customer.
 */

/**
 * Delivery capacity when a workspace has not set one.
 *
 * Zero, not unlimited. BUDGET_LEDGER.md's rule for cost limits is the same shape: an absent
 * ceiling is a refusal, not permission. A workspace that has never said how much delivery it
 * can absorb has not said "as much as you like".
 */
const DEFAULT_DELIVERY_CAPACITY = 0;

interface Case {
  opportunity: Awaited<ReturnType<typeof getOpportunity>> & object;
  match: OfferMatch;
  /** The matcher's own view, kept so the draft path does not have to re-derive it. */
  eligible: ReturnType<typeof matchOffers>['eligible'];
}

async function loadCase(tx: QueryExecutor, opportunityId: string): Promise<Case> {
  const opportunity = await getOpportunity(tx, opportunityId);
  if (!opportunity) throw new ApiProblem('NOT_FOUND', 'No such opportunity in this workspace.');

  // Confirmed only. A candidate is a question, not a need, and quoting one would be selling
  // work nobody has stood behind.
  const confirmedFindings = [];
  for (const findingId of opportunity.finding_ids) {
    const finding = await getFinding(tx, findingId);
    if (!finding || finding.state !== 'confirmed') continue;
    confirmedFindings.push({
      id: finding.id,
      detectorId: finding.detector_id,
      rootCauseKey: finding.root_cause_key,
    });
  }

  const catalog = await listCurrentOffers(tx, opportunity.venture_id);
  const prerequisites = await listOfferPrerequisites(tx, opportunity.account_id);
  const satisfiedPrerequisites = prerequisites
    .filter((row) => row.revoked_at === null)
    .map((row) => row.prerequisite);
  const openCommitments = await countOpenCommitments(tx);
  const deliveryCapacity = (await getDeliveryCapacity(tx)) ?? DEFAULT_DELIVERY_CAPACITY;

  const result = matchOffers({
    confirmedFindings,
    catalog: catalog.map(toCatalogOffer),
    satisfiedPrerequisites,
    openCommitments,
    deliveryCapacity,
  });

  const byId = new Map(catalog.map((row) => [row.id, row]));
  return {
    opportunity,
    eligible: result.eligible,
    match: {
      eligible: result.eligible.map((entry) => ({
        offer: toOffer(byId.get(entry.offer.id)!),
        finding_ids: entry.findingIds,
        root_cause_keys: entry.rootCauseKeys,
        unmet_prerequisites: entry.unmetPrerequisites,
        draftable: entry.draftable,
      })),
      rejected: result.rejected,
      route_to_manual_quotation: result.routeToManualQuotation,
      capacity_reached: result.capacityReached,
      open_commitments: openCommitments,
      delivery_capacity: deliveryCapacity,
    },
  };
}

export async function matchOffersForOpportunity(
  tx: QueryExecutor,
  opportunityId: string,
): Promise<{ ventureId: string; match: OfferMatch }> {
  const loaded = await loadCase(tx, opportunityId);
  return { ventureId: loaded.opportunity.venture_id, match: loaded.match };
}

export async function createOfferDraft(
  tx: QueryExecutor,
  deps: AppDependencies,
  input: {
    actor: RequestActor;
    opportunityId: string;
    body: CreateOfferDraft;
    requestId: string;
  },
): Promise<OfferDraftRow> {
  const offer = await getOffer(tx, input.body.offer_id);
  if (!offer) throw new ApiProblem('NOT_FOUND', 'No such offer in this workspace.');

  // Re-matched here rather than trusted from the client's last read. The eligibility a
  // reviewer saw may be minutes old, and a finding can be re-opened or a price withdrawn in
  // between; the state at the moment of drafting is the one that binds.
  const loaded = await loadCase(tx, input.opportunityId);
  const eligible = loaded.eligible.find((entry) => entry.offer.id === offer.id);

  if (!eligible) {
    const reason = loaded.match.rejected.find((entry) => entry.sku === offer.sku)?.reason;
    throw new ApiProblem(
      'OFFER_NOT_ELIGIBLE',
      reason === 'sku_has_no_approved_price' || reason === 'sku_not_enabled'
        ? `${offer.sku} has no owner-approved price. A price this system did not receive is not one it will quote.`
        : `${offer.sku} does not answer any confirmed finding on this case.`,
    );
  }
  if (eligible.unmetPrerequisites.length > 0) {
    throw new ApiProblem(
      'OFFER_PREREQUISITES_UNMET',
      `Record these first: ${eligible.unmetPrerequisites.join(', ')}.`,
    );
  }
  if (loaded.match.capacity_reached) {
    throw new ApiProblem(
      'DELIVERY_CAPACITY_REACHED',
      `${loaded.match.open_commitments} of ${loaded.match.delivery_capacity} delivery slots are committed. Quote the next available window rather than adding another.`,
    );
  }
  if (offer.currency === null || offer.price_minor === null) {
    // Unreachable through the matcher, which already refuses an unpriced SKU. Kept because
    // the alternative to this check is a draft with no price in it.
    throw new ApiProblem('OFFER_NOT_ELIGIBLE', `${offer.sku} has no approved price.`);
  }

  const draft = await insertOfferDraftOrConflict(tx, {
    id: deps.newId(),
    opportunityId: input.opportunityId,
    offerId: offer.id,
    offerSku: offer.sku,
    offerVersion: offer.version,
    currency: offer.currency,
    priceMinor: offer.price_minor,
    // The scope as it stood. A catalogue change afterwards writes a new version and leaves
    // this one exactly as it was quoted.
    snapshot: {
      promise: offer.promise,
      inclusions: offer.inclusions,
      exclusions: offer.exclusions,
      prerequisites: offer.prerequisites,
      acceptance: offer.acceptance,
      tax_treatment: offer.tax_treatment,
      min_effort_minutes: offer.min_effort_minutes,
      max_effort_minutes: offer.max_effort_minutes,
      approval_note: offer.approval_note,
    },
    findingIds: eligible.findingIds,
    rootCauseKeys: eligible.rootCauseKeys,
    createdBy: input.actor.membership.membershipId,
  });

  await insertAuditEvent(tx, {
    id: deps.newId(),
    actorSubject: input.actor.identity.subject,
    action: 'offer.draft',
    objectType: 'offer_draft',
    objectId: draft.id,
    objectVersion: draft.version,
    requestId: input.requestId,
    detail: {
      opportunity_id: input.opportunityId,
      offer_sku: offer.sku,
      offer_version: offer.version,
      currency: offer.currency,
      price_minor: offer.price_minor,
      finding_ids: eligible.findingIds,
      root_cause_keys: eligible.rootCauseKeys,
    },
  });

  return draft;
}

/**
 * One open draft per case and SKU, enforced by a partial unique index.
 *
 * A second open draft would be two prices for one job, which is how a customer ends up
 * holding the cheaper of two quotes nobody meant to give.
 */
async function insertOfferDraftOrConflict(
  tx: QueryExecutor,
  input: Parameters<typeof insertOfferDraft>[1],
): Promise<OfferDraftRow> {
  try {
    return await insertOfferDraft(tx, input);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { constraint?: string }).constraint === 'offer_drafts_one_open'
    ) {
      throw new ApiProblem(
        'OFFER_DRAFT_EXISTS',
        `${input.offerSku} is already drafted for this case. Withdraw that draft before writing another.`,
      );
    }
    throw error;
  }
}

export async function withdrawDraft(
  tx: QueryExecutor,
  deps: AppDependencies,
  input: {
    actor: RequestActor;
    draftId: string;
    body: WithdrawOfferDraft;
    requestId: string;
  },
): Promise<OfferDraftRow> {
  const withdrawn = await withdrawOfferDraft(tx, {
    id: input.draftId,
    expectedVersion: input.body.expected_version,
    reason: input.body.reason,
    at: deps.now().toISOString(),
  });
  if (!withdrawn) {
    throw new ApiProblem(
      'STALE_REVIEW',
      'That draft is no longer open at the version you sent. Re-read it before withdrawing.',
    );
  }

  await insertAuditEvent(tx, {
    id: deps.newId(),
    actorSubject: input.actor.identity.subject,
    action: 'offer.withdraw',
    objectType: 'offer_draft',
    objectId: withdrawn.id,
    objectVersion: withdrawn.version,
    requestId: input.requestId,
    detail: {
      opportunity_id: withdrawn.opportunity_id,
      offer_sku: withdrawn.offer_sku,
      reason: input.body.reason,
    },
  });

  return withdrawn;
}
