import type { ReviewFinding } from '@oe/contracts';
import { transition, TransitionError } from '@oe/domain';
import {
  applyFindingReview,
  findingEvidenceIds,
  getFinding,
  insertAuditEvent,
  insertReview,
  listEvidenceByIds,
  type FindingRow,
  type QueryExecutor,
} from '@oe/db';
import { ApiProblem } from '../problem.ts';
import type { AppDependencies, RequestActor } from '../context.ts';

/**
 * Human review of a candidate finding.
 *
 * WORKFLOWS.md: "Confirmation requires supporting evidence, reviewed limitations, no
 * unresolved contradiction, current evidence scope and a reviewer bound to that finding
 * version." Every one of those is checked here, in the same transaction as the state change.
 */
export async function reviewFinding(
  tx: QueryExecutor,
  deps: AppDependencies,
  input: {
    actor: RequestActor;
    findingId: string;
    body: ReviewFinding;
    requestId: string;
  },
): Promise<FindingRow> {
  const finding = await getFinding(tx, input.findingId);
  if (!finding) throw new ApiProblem('NOT_FOUND', 'No such finding in this workspace.');

  const nextState = input.body.decision === 'confirm' ? 'confirmed' : input.body.decision === 'reject' ? 'rejected' : 'unknown';

  // Shape guard first, so an illegal edge is reported as such rather than as a conflict.
  try {
    transition({
      kind: 'finding',
      state: finding.state,
      version: finding.version,
      expectedVersion: input.body.expected_version,
      next: nextState,
    });
  } catch (error) {
    if (error instanceof TransitionError) {
      if (error.code === 'VERSION_CONFLICT') {
        throw new ApiProblem(
          'STALE_REVIEW',
          `This finding is now at version ${finding.version}. Your notes are kept; review the current evidence before deciding.`,
        );
      }
      throw new ApiProblem(
        'INVALID_TRANSITION',
        `A ${finding.state} finding cannot become ${nextState}.`,
      );
    }
    throw error;
  }

  if (nextState === 'confirmed') {
    await assertConfirmable(tx, deps, finding);
  }

  const reviewedAt = deps.now().toISOString();
  const updated = await applyFindingReview(tx, {
    findingId: finding.id,
    expectedVersion: input.body.expected_version,
    nextState,
    // A rejection records who rejected it; only a confirmation binds the reviewer as the
    // person standing behind the claim.
    reviewerId: input.actor.membership.membershipId,
    reviewedAt,
  });
  if (!updated) {
    // Another reviewer won the compare-and-swap between our read and our write.
    throw new ApiProblem(
      'STALE_REVIEW',
      'Another reviewer updated this finding first. Your notes are kept; re-review the current version.',
    );
  }

  // The review event is immutable history keyed by (finding, version), so the same version
  // cannot be decided twice even under a retry.
  await insertReview(tx, {
    id: deps.newId(),
    findingId: finding.id,
    findingVersion: input.body.expected_version,
    reviewerId: input.actor.membership.membershipId,
    decision: input.body.decision,
    reason: input.body.reason,
  });

  await insertAuditEvent(tx, {
    id: deps.newId(),
    actorSubject: input.actor.identity.subject,
    action: `finding.${input.body.decision}`,
    objectType: 'finding',
    objectId: finding.id,
    objectVersion: updated.version,
    requestId: input.requestId,
    detail: {
      detector_id: finding.detector_id,
      detector_version: finding.detector_version,
      from_state: finding.state,
      to_state: nextState,
      acknowledged_limitations: input.body.acknowledged_limitations,
    },
  });

  return updated;
}

/**
 * The evidence conditions for a confirmation.
 *
 * A reviewer cannot confirm a finding whose supporting evidence is missing, incomplete,
 * expired or contradicted. This is deliberately server-side: a UI that forgot to disable a
 * button must not be able to produce a confirmed claim.
 */
async function assertConfirmable(
  tx: QueryExecutor,
  deps: AppDependencies,
  finding: FindingRow,
): Promise<void> {
  const links = await findingEvidenceIds(tx, finding.id);
  if (links.supports.length === 0) {
    throw new ApiProblem('EVIDENCE_INCOMPLETE', 'This finding has no supporting evidence to confirm.');
  }
  if (links.contradicts.length > 0) {
    throw new ApiProblem(
      'EVIDENCE_INCOMPLETE',
      'Contrary evidence is recorded against this finding. Resolve it before confirming.',
    );
  }
  if (finding.evidence_grade !== 'A' && finding.evidence_grade !== 'B') {
    throw new ApiProblem(
      'EVIDENCE_INCOMPLETE',
      'Only grade A or B evidence can support a confirmed finding.',
    );
  }
  const evidence = await listEvidenceByIds(tx, links.supports);
  if (evidence.length !== links.supports.length) {
    throw new ApiProblem('EVIDENCE_INCOMPLETE', 'Some supporting evidence is no longer retrievable.');
  }
  if (evidence.some((row) => !row.complete)) {
    throw new ApiProblem('EVIDENCE_INCOMPLETE', 'An incomplete capture cannot support a confirmed finding.');
  }
  const now = deps.now().getTime();
  if (evidence.some((row) => Date.parse(row.expires_at) <= now)) {
    throw new ApiProblem(
      'EVIDENCE_INCOMPLETE',
      'Supporting evidence has passed its retention date. Re-capture before confirming.',
    );
  }
  if (finding.evidence_fresh_until && Date.parse(finding.evidence_fresh_until) <= now) {
    throw new ApiProblem(
      'EVIDENCE_INCOMPLETE',
      'This evidence is stale. Revalidate the observation before confirming.',
    );
  }
}
