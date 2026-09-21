import { createHash } from 'node:crypto';
import type { CreateReport } from '@oe/contracts';
import {
  findingEvidenceIds,
  getAccount,
  getFinding,
  getScan,
  insertAuditEvent,
  insertReport,
  linkReportFinding,
  listEvidenceByIds,
  type QueryExecutor,
  type ReportRow,
} from '@oe/db';
import { ApiProblem } from '../problem.ts';
import type { AppDependencies, RequestActor } from '../context.ts';

/**
 * Report composition.
 *
 * WORKFLOWS.md: "Create immutable snapshots of finding IDs and versions, detector/capture
 * conditions, exclusions, customer/tenant binding and reviewer. A published report never
 * silently changes when a source row updates."
 *
 * The body is rendered once, here, from the exact reviewed versions, and hashed. Nothing
 * downstream re-renders it from live rows.
 */

export interface ReportBody {
  title: string;
  scope_summary: string;
  as_of: string;
  language: 'en' | 'de';
  inspected: {
    target_url: string;
    expected_unique_pages: number;
    captured_unique_pages: number;
    partial_reasons: string[];
  };
  confirmed_findings: {
    finding_id: string;
    version: number;
    claim: string;
    scope: string;
    limitations: string[];
    detector_id: string;
    detector_version: string;
    evidence_grade: 'A' | 'B' | 'C' | null;
    commercial_impact: string;
    observed_conditions: {
      evidence_id: string;
      captured_at: string;
      http_status: number | null;
      final_url: string;
      session_id: string;
      viewport: string;
      locale: string;
      variant: string | null;
      consent_state: string;
      browser_version: string;
    }[];
  }[];
  /** Present and explicit when the inspected sample supported no defect. */
  no_supported_defect: boolean;
  exclusions: string[];
  limitations: string[];
}

const BASE_LIMITATIONS = [
  'Only the pages and links listed under "inspected" were checked.',
  'The effect on sales has not been measured.',
  'Private account configuration was not inspected.',
];

const EXCLUSIONS = [
  'No change was made to the inspected site.',
  'No private or logged-in area was accessed.',
  'This assessment is not a guarantee of platform approval, compliance or revenue.',
];

export async function createReport(
  tx: QueryExecutor,
  deps: AppDependencies,
  input: { actor: RequestActor; body: CreateReport; requestId: string },
): Promise<{ row: ReportRow; body: ReportBody }> {
  const scan = await getScan(tx, input.body.scan_id);
  if (!scan) throw new ApiProblem('NOT_FOUND', 'No such scan in this workspace.');
  if (scan.account_id !== input.body.account_id) {
    throw new ApiProblem('INVALID_REQUEST', 'That scan does not belong to the named account.');
  }
  const account = await getAccount(tx, input.body.account_id);
  if (!account) throw new ApiProblem('NOT_FOUND', 'No such account in this workspace.');
  if (!input.actor.membership.ventureIds.includes(account.venture_id)) {
    throw new ApiProblem('VENTURE_NOT_ASSIGNED', 'This membership is not assigned to that venture.');
  }

  const asOf = deps.now().toISOString();
  const confirmed: ReportBody['confirmed_findings'] = [];

  for (const ref of input.body.finding_versions) {
    const finding = await getFinding(tx, ref.finding_id);
    if (!finding) throw new ApiProblem('NOT_FOUND', 'A referenced finding does not exist in this workspace.');
    if (finding.scan_id !== scan.id) {
      throw new ApiProblem('INVALID_REQUEST', 'A referenced finding belongs to a different scan.');
    }
    // The version the reviewer approved must still be the current one.
    if (finding.version !== ref.version) {
      throw new ApiProblem(
        'STALE_REVIEW',
        `Finding ${finding.id} is now at version ${finding.version}. Re-review it before building a report.`,
      );
    }
    if (finding.state !== 'confirmed') {
      throw new ApiProblem(
        'EVIDENCE_INCOMPLETE',
        'Only confirmed findings can appear in a report. Rejected and unknown findings are excluded.',
      );
    }
    // M1 customer defect reports require A-grade evidence (WORKFLOWS.md).
    if (finding.evidence_grade !== 'A') {
      throw new ApiProblem(
        'EVIDENCE_INCOMPLETE',
        'This milestone publishes grade A findings only. Grade B belongs in the reviewed-improvement section introduced in M2.',
      );
    }
    const links = await findingEvidenceIds(tx, finding.id);
    const evidence = await listEvidenceByIds(tx, links.supports);
    if (evidence.length === 0) {
      throw new ApiProblem('EVIDENCE_INCOMPLETE', 'A referenced finding has no retrievable evidence.');
    }
    confirmed.push({
      finding_id: finding.id,
      version: finding.version,
      claim: finding.claim,
      scope: finding.scope,
      limitations: finding.limitations,
      detector_id: finding.detector_id,
      detector_version: finding.detector_version,
      evidence_grade: finding.evidence_grade,
      commercial_impact: finding.commercial_impact,
      observed_conditions: evidence.map((row) => {
        const conditions = row.conditions as Record<string, unknown>;
        return {
          evidence_id: row.id,
          captured_at: row.captured_at,
          http_status: row.http_status,
          final_url: row.final_url,
          session_id: String(conditions.session_id ?? 'unknown'),
          viewport: `${conditions.viewport_width ?? '?'}×${conditions.viewport_height ?? '?'}`,
          locale: String(conditions.locale ?? 'unknown'),
          variant: (conditions.variant as string | null) ?? null,
          consent_state: String(conditions.consent_state ?? 'unknown'),
          browser_version: String(conditions.browser_version ?? 'unknown'),
        };
      }),
    });
  }

  const partialReasons = Array.isArray(scan.reasons) ? scan.reasons.map(String) : [];
  const body: ReportBody = {
    title: `${account.name} · inspected information links`,
    scope_summary: input.body.scope_summary,
    as_of: asOf,
    language: input.body.language,
    inspected: {
      target_url: scan.target_url,
      expected_unique_pages: scan.expected_unique_pages,
      captured_unique_pages: scan.captured_unique_pages,
      partial_reasons: partialReasons,
    },
    confirmed_findings: confirmed,
    // COPY.md: "No supported defect was found in the inspected sample" — scope-limited, not
    // a statement that the store is healthy.
    no_supported_defect: confirmed.length === 0,
    exclusions: EXCLUSIONS,
    limitations:
      scan.captured_unique_pages < scan.expected_unique_pages
        ? [
            ...BASE_LIMITATIONS,
            `${scan.captured_unique_pages} of ${scan.expected_unique_pages} pages were captured. The remaining pages could not be inspected.`,
          ]
        : BASE_LIMITATIONS,
  };

  const bodySha256 = createHash('sha256').update(canonical(body)).digest('hex');
  const row = await insertReport(tx, {
    id: deps.newId(),
    accountId: input.body.account_id,
    scanId: scan.id,
    language: input.body.language,
    snapshot: {
      scope_summary: input.body.scope_summary,
      limitations: body.limitations,
      as_of: asOf,
      reviewer_membership_id: input.actor.membership.membershipId,
      detector_versions: [...new Set(confirmed.map((f) => `${f.detector_id}@${f.detector_version}`))],
      scan_version_at_creation: scan.version,
    },
    body: body as unknown as Record<string, unknown>,
    bodySha256,
  });

  for (const ref of input.body.finding_versions) {
    await linkReportFinding(tx, {
      id: deps.newId(),
      reportId: row.id,
      findingId: ref.finding_id,
      findingVersion: ref.version,
    });
  }

  await insertAuditEvent(tx, {
    id: deps.newId(),
    actorSubject: input.actor.identity.subject,
    action: 'report.created',
    objectType: 'report',
    objectId: row.id,
    objectVersion: row.version,
    requestId: input.requestId,
    detail: {
      scan_id: scan.id,
      finding_count: confirmed.length,
      no_supported_defect: body.no_supported_defect,
      body_sha256: bodySha256,
    },
  });

  return { row, body };
}

/**
 * Re-verify every bound finding version in the same transaction as the publication state
 * change (API_GUIDE.md). A finding that moved since the draft blocks publication.
 */
export async function assertPublishable(
  tx: QueryExecutor,
  deps: AppDependencies,
  reportId: string,
  boundFindings: { finding_id: string; finding_version: number }[],
): Promise<void> {
  void reportId;
  for (const bound of boundFindings) {
    const finding = await getFinding(tx, bound.finding_id);
    if (!finding) throw new ApiProblem('NOT_FOUND', 'A bound finding no longer exists.');
    if (finding.version !== bound.finding_version || finding.state !== 'confirmed') {
      throw new ApiProblem(
        'STALE_REVIEW',
        'A finding in this report changed after it was approved. Re-review and create a new report version.',
      );
    }
    const links = await findingEvidenceIds(tx, finding.id);
    const evidence = await listEvidenceByIds(tx, links.supports);
    const now = deps.now().getTime();
    if (evidence.length === 0 || evidence.some((row) => Date.parse(row.expires_at) <= now)) {
      throw new ApiProblem(
        'EVIDENCE_INCOMPLETE',
        'Evidence behind this report has expired. Re-capture before publishing.',
      );
    }
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
