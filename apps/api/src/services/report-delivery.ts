import {
  getReport,
  insertAuditEvent,
  insertReportGrant,
  listReportFindings,
  resolveReportGrant,
  revokeReportGrant,
  type ReportGrantRow,
  type ReportRow,
} from '@oe/db';
import { hashToken, newAccessToken, opaqueKey } from '@oe/notify';
import { ApiProblem } from '../problem.ts';
import type { AppDependencies, RequestActor } from '../context.ts';

/**
 * Getting a reviewed report to the person it is about, without giving them a seat.
 *
 * ACCESS_MODEL.md calls this the one genuinely hard case: "A client who wants to see their own
 * case... giving them a membership would let them see every other account in it. Do not solve
 * this by creating viewer memberships for clients. It is the single most likely way this
 * system leaks one customer's data to another."
 *
 * So a grant is deliberately not an account. It opens **one report version**, for a bounded
 * time, revocably, and nothing else. There is no session, no membership, no role, and no route
 * from a grant to any other object — not the scan, not the evidence artifacts, not the
 * account, not another report.
 */

/** Two weeks. Long enough to read and discuss, short enough that a leaked link stops working. */
const GRANT_TTL_SECONDS = 14 * 86_400;

function requireSecret(deps: AppDependencies): string {
  // The same secret keys intake codes and report tokens, and its absence is the same failure:
  // something that must be unguessable would be stored in a form somebody could reverse.
  if (deps.config.intake.secret === null) {
    throw new ApiProblem(
      'PROVIDER_NOT_CONFIGURED',
      'Report delivery needs INTAKE_SECRET. Refusing rather than issuing a link that cannot be stored safely.',
    );
  }
  return deps.config.intake.secret;
}

export interface IssuedGrant {
  grant: ReportGrantRow;
  /**
   * The only time this value exists outside a hash. It is returned once, to the operator who
   * issued it, and never again — not by a list, not by a read, not by a re-issue.
   */
  token: string;
  url: string;
}

export async function issueReportGrant(
  tx: Parameters<typeof getReport>[0],
  deps: AppDependencies,
  input: {
    actor: RequestActor;
    reportId: string;
    recipientNote: string;
    /** Opaque-keyed, never stored raw. Lets an operator revoke by recipient without an address. */
    recipientRef: string;
    requestId: string;
  },
): Promise<IssuedGrant> {
  const secret = requireSecret(deps);
  const report = await getReport(tx, input.reportId);
  if (!report) throw new ApiProblem('NOT_FOUND', 'No such report in this workspace.');

  // Only a published report may be delivered. A draft is a working document and an approved
  // one has not been published yet; sending either would put a version in front of a customer
  // that nobody decided to show them. A revoked report is revoked for a reason.
  if (report.state !== 'published') {
    throw new ApiProblem(
      'INVALID_TRANSITION',
      `A ${report.state} report cannot be delivered. Publish it first.`,
    );
  }

  const token = newAccessToken();
  const now = deps.now();
  const grant = await insertReportGrant(tx, {
    id: deps.newId(),
    reportId: report.id,
    // Bound to the version, not just the report. A later version does not start serving
    // through a link somebody already has; issuing a new one is a deliberate act.
    reportVersion: report.version,
    tokenHash: hashToken(secret, 'report_access', token),
    recipientHash: Buffer.from(opaqueKey(secret, 'report_recipient', input.recipientRef), 'hex'),
    recipientNote: input.recipientNote,
    expiresAt: new Date(now.getTime() + GRANT_TTL_SECONDS * 1000).toISOString(),
    createdBy: input.actor.membership.membershipId,
  });

  await insertAuditEvent(tx, {
    id: deps.newId(),
    actorSubject: input.actor.identity.subject,
    action: 'report_grant.issued',
    objectType: 'report_grant',
    objectId: grant.id,
    objectVersion: 1,
    requestId: input.requestId,
    // No token, no address. What a later reader needs is that a link was issued, for which
    // version, by whom, and until when.
    detail: {
      report_id: report.id,
      report_version: report.version,
      expires_at: grant.expires_at,
      recipient_note: grant.recipient_note,
    },
  });

  // The URL of the thing that actually exists. A branded HTML reader is M3 slice 3; until it
  // is built, handing out a link to a page that 404s would be worse than handing out none.
  return { grant, token, url: `${deps.config.appOrigin}/public/reports/${token}` };
}

export async function revokeGrant(
  tx: Parameters<typeof getReport>[0],
  deps: AppDependencies,
  input: { actor: RequestActor; grantId: string; reason: string; requestId: string },
): Promise<ReportGrantRow> {
  const revoked = await revokeReportGrant(tx, {
    id: input.grantId,
    reason: input.reason,
    revokedBy: input.actor.membership.membershipId,
    at: deps.now().toISOString(),
  });
  if (!revoked) {
    throw new ApiProblem('NOT_FOUND', 'No such live grant in this workspace.');
  }

  await insertAuditEvent(tx, {
    id: deps.newId(),
    actorSubject: input.actor.identity.subject,
    action: 'report_grant.revoked',
    objectType: 'report_grant',
    objectId: revoked.id,
    objectVersion: 1,
    requestId: input.requestId,
    detail: { report_id: revoked.report_id, reason: input.reason },
  });

  return revoked;
}

/* ------------------------------------------------------- the public read */

export interface DeliveredReport {
  grant: ReportGrantRow;
  report: ReportRow;
  findingVersions: { finding_id: string; finding_version: number }[];
}

/**
 * Resolve a token and read what it opens.
 *
 * **This performs no business write.** M3: "GET tokens never mutate data." No counter on the
 * grant, no last-accessed column, no state change on the report. That the link was used is
 * recorded as an append-only audit event, which is history rather than state — a reader
 * cannot change what the next reader sees.
 *
 * Every failure mode returns the same `NOT_FOUND`. Expired, revoked, mistyped, belonging to
 * another workspace, or never issued at all: from outside they are one answer, because the
 * differences are exactly what somebody probing with guessed tokens would like to learn.
 */
export async function readDeliveredReport(
  deps: AppDependencies,
  token: string,
  requestId: string,
): Promise<DeliveredReport> {
  const secret = requireSecret(deps);
  const notFound = new ApiProblem(
    'NOT_FOUND',
    'This link is not valid. It may have expired, or been withdrawn.',
  );

  // Shape-checked before it touches the database, so a long or malformed string cannot become
  // a lookup at all.
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) throw notFound;

  const tokenHash = hashToken(secret, 'report_access', token);
  // No tenant context: the tenant is what this answers. Migration 0012's policy is narrower
  // than the query — it returns nothing for a revoked or expired grant — so those two cases
  // are already indistinguishable before any code here could tell them apart.
  const grant = await deps.identityDb.withoutTenant((tx) => resolveReportGrant(tx, tokenHash));
  if (!grant) throw notFound;

  return deps.db.withTenant(grant.tenant_id, async (tx) => {
    const report = await getReport(tx, grant.report_id);
    if (!report) throw notFound;
    // The grant names a version. A report that has moved on since is not what was shared, and
    // serving the newer one would be a silent substitution of a document somebody was given.
    if (report.version !== grant.report_version) throw notFound;
    if (report.state !== 'published') throw notFound;

    await insertAuditEvent(tx, {
      id: deps.newId(),
      // Not a member of this workspace. The grant records who it was issued to.
      actorSubject: `public:report_grant@${grant.id}`,
      action: 'report_grant.read',
      objectType: 'report',
      objectId: report.id,
      objectVersion: report.version,
      requestId,
      detail: { grant_id: grant.id, report_version: report.version },
    });

    return { grant, report, findingVersions: await listReportFindings(tx, report.id) };
  });
}
