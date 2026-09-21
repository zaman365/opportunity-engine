import { transition, TransitionError } from '@oe/domain';
import {
  advanceEngagement,
  getEngagement,
  getOffer,
  getOpportunity,
  insertAuditEvent,
  insertEngagement,
  insertEngagementEvent,
  insertPaymentRecord,
  listOfferDrafts,
  type EngagementRow,
  type PaymentRecordRow,
  type QueryExecutor,
} from '@oe/db';
import { ApiProblem } from '../problem.ts';
import type { AppDependencies, RequestActor } from '../context.ts';

/**
 * Work somebody agreed to buy.
 *
 * WORKFLOWS.md: "No start before accepted offer version, required permissions and
 * payment/contract prerequisites. Acceptance follows verified work plus customer/authorized
 * owner acceptance, not a 'payment succeeded' webhook. Scope change creates a new approved
 * version."
 *
 * Three things follow from that and shape everything here.
 *
 * **An engagement is against a draft, and a draft is immutable.** There is no scope to edit;
 * a changed scope means a new draft and a new engagement. The state machine's
 * `change_requested → draft` edge is that, not an amendment path.
 *
 * **Acceptance is a recorded act, not a payment event.** It carries a time, a note saying how
 * it was obtained, and the member attesting to it — the same shape as a review, because it is
 * the same kind of claim. A payment record is a separate, later fact and moves nothing.
 *
 * **Nothing starts before acceptance.** Checked here so the refusal is readable, and again as
 * a CHECK constraint so it holds against a caller that skipped this file.
 */

/** Acceptance is required to leave these states. Mirrors the constraint in migration 0013. */
const PRE_ACCEPTANCE_STATES = ['draft', 'awaiting_acceptance', 'cancelled', 'change_requested'];

/** These need a reason and an owner, and the constraint refuses them without. */
const SIDE_STATES = ['change_requested', 'disputed', 'cancelled'];

export async function createEngagement(
  tx: QueryExecutor,
  deps: AppDependencies,
  input: {
    actor: RequestActor;
    opportunityId: string;
    offerDraftId: string;
    requestId: string;
  },
): Promise<EngagementRow> {
  const opportunity = await getOpportunity(tx, input.opportunityId);
  if (!opportunity) throw new ApiProblem('NOT_FOUND', 'No such opportunity in this workspace.');

  const draft = (await listOfferDrafts(tx, input.opportunityId)).find(
    (row) => row.id === input.offerDraftId,
  );
  if (!draft) throw new ApiProblem('NOT_FOUND', 'No such drafted scope on this case.');
  // A withdrawn or superseded draft is not a quote anybody holds. Starting work against one
  // would commit to a price that was taken back.
  if (draft.state !== 'draft') {
    throw new ApiProblem(
      'INVALID_TRANSITION',
      `That scope is ${draft.state}. Draft a current one before starting work against it.`,
    );
  }

  // The catalogue entry must still be the one that was quoted. A SKU version is never edited
  // in place, so this is a check that the draft's version still exists — not that the
  // catalogue agrees with it today, which is the whole point of the snapshot.
  const offer = await getOffer(tx, draft.offer_id);
  if (!offer) throw new ApiProblem('NOT_FOUND', 'The catalogue entry behind that scope is gone.');

  const engagement = await insertEngagementOrConflict(tx, {
    id: deps.newId(),
    opportunityId: input.opportunityId,
    accountId: opportunity.account_id,
    offerDraftId: draft.id,
    createdBy: input.actor.membership.membershipId,
  });

  await insertEngagementEvent(tx, {
    id: deps.newId(),
    engagementId: engagement.id,
    fromState: 'draft',
    toState: 'draft',
    toVersion: engagement.version,
    reason: `Opened against ${draft.offer_sku} v${draft.offer_version}.`,
    actorId: input.actor.membership.membershipId,
  });

  await insertAuditEvent(tx, {
    id: deps.newId(),
    actorSubject: input.actor.identity.subject,
    action: 'engagement.opened',
    objectType: 'engagement',
    objectId: engagement.id,
    objectVersion: engagement.version,
    requestId: input.requestId,
    detail: {
      opportunity_id: input.opportunityId,
      offer_sku: draft.offer_sku,
      offer_version: draft.offer_version,
      currency: draft.currency,
      price_minor: draft.price_minor,
    },
  });

  return engagement;
}

async function insertEngagementOrConflict(
  tx: QueryExecutor,
  input: Parameters<typeof insertEngagement>[1],
): Promise<EngagementRow> {
  try {
    return await insertEngagement(tx, input);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { constraint?: string }).constraint === 'engagements_one_live_per_draft'
    ) {
      throw new ApiProblem(
        'VERSION_CONFLICT',
        'There is already a live engagement against that scope. Close or cancel it first.',
      );
    }
    throw error;
  }
}

export interface AdvanceInput {
  actor: RequestActor;
  engagementId: string;
  expectedVersion: number;
  nextState: string;
  reason: string;
  /** Required when leaving the pre-acceptance states, refused otherwise. */
  acceptanceNote: string | null;
  requestId: string;
}

export async function advance(
  tx: QueryExecutor,
  deps: AppDependencies,
  input: AdvanceInput,
): Promise<EngagementRow> {
  const engagement = await getEngagement(tx, input.engagementId);
  if (!engagement) throw new ApiProblem('NOT_FOUND', 'No such engagement in this workspace.');

  // Shape first, so an illegal edge is reported as such rather than as a conflict.
  try {
    transition({
      kind: 'engagement',
      state: engagement.state,
      version: engagement.version,
      expectedVersion: input.expectedVersion,
      next: input.nextState,
    });
  } catch (error) {
    if (error instanceof TransitionError) {
      if (error.code === 'VERSION_CONFLICT') {
        throw new ApiProblem(
          'VERSION_CONFLICT',
          `This engagement is now at version ${engagement.version}. Re-read it before moving it.`,
        );
      }
      throw new ApiProblem(
        'INVALID_TRANSITION',
        `A ${engagement.state} engagement cannot become ${input.nextState}.`,
      );
    }
    throw error;
  }

  const crossesAcceptance =
    PRE_ACCEPTANCE_STATES.includes(engagement.state) &&
    !PRE_ACCEPTANCE_STATES.includes(input.nextState);

  if (crossesAcceptance && engagement.accepted_at === null) {
    // The one place acceptance is recorded. It needs the note, because "they accepted" with
    // nothing behind it is the assertion a dispute would turn on.
    if (input.acceptanceNote === null || input.acceptanceNote.trim().length < 10) {
      throw new ApiProblem(
        'INVALID_REQUEST',
        'Recording acceptance needs a note saying how it was obtained. A payment is not an acceptance.',
      );
    }
  } else if (input.acceptanceNote !== null) {
    // Refused rather than ignored: silently dropping it would let somebody believe they had
    // recorded an acceptance that is not there.
    throw new ApiProblem(
      'INVALID_REQUEST',
      'This transition does not record an acceptance. Remove the note.',
    );
  }

  const needsSide = SIDE_STATES.includes(input.nextState);
  const moved = await advanceEngagement(tx, {
    id: engagement.id,
    expectedVersion: input.expectedVersion,
    nextState: input.nextState,
    acceptance:
      crossesAcceptance && engagement.accepted_at === null
        ? {
            at: deps.now().toISOString(),
            note: input.acceptanceNote!,
            by: input.actor.membership.membershipId,
          }
        : null,
    side: needsSide ? { reason: input.reason, owner: input.actor.membership.membershipId } : null,
  });
  if (!moved) {
    throw new ApiProblem(
      'VERSION_CONFLICT',
      'Another member moved this engagement first. Re-read it before moving it.',
    );
  }

  await insertEngagementEvent(tx, {
    id: deps.newId(),
    engagementId: moved.id,
    fromState: engagement.state,
    toState: moved.state,
    toVersion: moved.version,
    reason: input.reason,
    actorId: input.actor.membership.membershipId,
  });

  await insertAuditEvent(tx, {
    id: deps.newId(),
    actorSubject: input.actor.identity.subject,
    action: `engagement.${moved.state}`,
    objectType: 'engagement',
    objectId: moved.id,
    objectVersion: moved.version,
    requestId: input.requestId,
    detail: {
      from_state: engagement.state,
      to_state: moved.state,
      reason: input.reason,
      recorded_acceptance: crossesAcceptance && engagement.accepted_at === null,
    },
  });

  return moved;
}

/**
 * Record what happened with money, as a fact somebody typed.
 *
 * No card data, no processor token, no webhook. It moves no state: a payment is evidence that
 * money arrived, not evidence that work was accepted, and conflating the two is exactly what
 * WORKFLOWS.md rules out.
 */
export async function recordPayment(
  tx: QueryExecutor,
  deps: AppDependencies,
  input: {
    actor: RequestActor;
    engagementId: string;
    kind: string;
    currency: string;
    amountMinor: string;
    externalRef: string;
    note: string;
    occurredAt: string;
    requestId: string;
  },
): Promise<PaymentRecordRow> {
  const engagement = await getEngagement(tx, input.engagementId);
  if (!engagement) throw new ApiProblem('NOT_FOUND', 'No such engagement in this workspace.');

  const record = await insertPaymentRecord(tx, {
    id: deps.newId(),
    engagementId: engagement.id,
    kind: input.kind,
    currency: input.currency,
    amountMinor: input.amountMinor,
    externalRef: input.externalRef,
    note: input.note,
    occurredAt: input.occurredAt,
    recordedBy: input.actor.membership.membershipId,
  });

  await insertAuditEvent(tx, {
    id: deps.newId(),
    actorSubject: input.actor.identity.subject,
    action: `payment.${input.kind}`,
    objectType: 'payment_record',
    objectId: record.id,
    objectVersion: 1,
    requestId: input.requestId,
    detail: {
      engagement_id: engagement.id,
      kind: record.kind,
      currency: record.currency,
      amount_minor: record.amount_minor,
      external_ref: record.external_ref,
      // Stated in the trail because it is the thing somebody will later assume happened.
      moved_engagement_state: false,
    },
  });

  return record;
}
