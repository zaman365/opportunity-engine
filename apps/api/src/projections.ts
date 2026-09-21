import type {
  Account,
  Authorization,
  Budget,
  Evidence,
  Finding,
  Offer,
  OfferDraft,
  OfferPrerequisite,
  Opportunity,
  PriorityScore,
  Report,
  Review,
  Scan,
  ScanStep,
} from '@oe/contracts';
import { effortBand, type CatalogOffer } from '@oe/domain';
import type {
  AccountRow,
  AuthorizationRow,
  BudgetRow,
  EvidenceRow,
  FindingRow,
  OfferDraftRow,
  OfferPrerequisiteRow,
  OfferRow,
  OpportunityRow,
  ReportRow,
  ReviewRow,
  ScanRow,
  ScanStepRow,
} from '@oe/db';

/**
 * Row → wire projections.
 *
 * API_GUIDE.md: "List results are role-scoped projections; do not include secrets, private
 * storage keys, other-tenant counts or arbitrary scraped content." Object keys, raw page
 * bodies, source notes and reviewer reasons are deliberately absent from these shapes.
 */

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    canonical_domain: row.canonical_domain,
    venture_id: row.venture_id,
    approved_hosts: row.approved_hosts,
    version: row.version,
    created_at: row.created_at,
  };
}

export function toAuthorization(row: AuthorizationRow): Authorization {
  return {
    id: row.id,
    account_id: row.account_id,
    action: row.action,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    policy_version: row.policy_version,
  };
}

export interface ScanCostSnapshot {
  currency: string;
  capMicro: string;
  settledMicro: string;
  reservedMicro: string;
  settlementUncertain: boolean;
}

export function toScan(
  row: ScanRow,
  cost: ScanCostSnapshot,
  evidenceIds: string[],
  findingIds: string[],
): Scan {
  // `reasons` carries the structured partial/blocked explanation; the blocked headline is
  // the first reason so a client never has to guess which one to show.
  const reasons = Array.isArray(row.reasons) ? row.reasons.map(String) : [];
  const blocked = row.state === 'blocked' || row.state === 'failed';
  return {
    id: row.id,
    account_id: row.account_id,
    venture_id: row.venture_id,
    state: row.state as Scan['state'],
    version: row.version,
    target_url: row.target_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
    coverage: {
      expected_unique_pages: row.expected_unique_pages,
      captured_unique_pages: row.captured_unique_pages,
      complete_checks: findingIds.length,
      reasons,
    },
    cost: {
      cap: { currency: cost.currency, amount_micro: cost.capMicro },
      settled: { currency: cost.currency, amount_micro: cost.settledMicro },
      reserved: { currency: cost.currency, amount_micro: cost.reservedMicro },
      settlement_uncertain: cost.settlementUncertain,
    },
    evidence_ids: evidenceIds,
    finding_ids: findingIds,
    blocked_reason: blocked && reasons.length > 0 ? reasons[0]! : null,
  };
}

export function toEvidence(row: EvidenceRow, contentAvailable: boolean): Evidence {
  const conditions = row.conditions as Evidence['conditions'];
  return {
    id: row.id,
    scan_id: row.scan_id,
    asset_id: row.asset_id,
    source_url: row.source_url,
    final_url: row.final_url,
    kind: row.kind,
    sha256: row.sha256,
    conditions,
    observation: row.observation,
    http_status: row.http_status,
    complete: row.complete,
    expires_at: row.expires_at,
    content_available: contentAvailable,
    redacted: row.redacted,
  };
}

export function toFinding(
  row: FindingRow,
  evidenceIds: string[],
  contraryEvidenceIds: string[],
): Finding {
  return {
    id: row.id,
    scan_id: row.scan_id,
    asset_id: row.asset_id,
    detector_id: row.detector_id,
    detector_version: row.detector_version,
    state: row.state as Finding['state'],
    version: row.version,
    root_cause_key: row.root_cause_key,
    claim: row.claim,
    evidence_ids: evidenceIds,
    contrary_evidence_ids: contraryEvidenceIds,
    scope: row.scope,
    limitations: row.limitations,
    evidence_grade: row.evidence_grade,
    commercial_impact: row.commercial_impact as Finding['commercial_impact'],
    captured_at: row.captured_at,
    reviewer_id: row.reviewer_id,
    reviewed_at: row.reviewed_at,
  };
}

export function toOpportunity(
  row: OpportunityRow & { finding_ids: string[] },
  account: Account,
): Opportunity {
  return {
    id: row.id,
    account,
    venture_id: row.venture_id,
    finding_ids: row.finding_ids,
    title: row.title,
    priority: (row.priority as PriorityScore | null) ?? null,
    permission_state: row.permission_state as Opportunity['permission_state'],
    next_action: row.next_action as Opportunity['next_action'],
    owner_id: row.owner_id,
    updated_at: row.updated_at,
  };
}

export function toReport(
  row: ReportRow,
  findingVersions: { finding_id: string; finding_version: number }[],
): Report {
  const snapshot = row.snapshot as { scope_summary?: string; limitations?: string[] };
  return {
    id: row.id,
    account_id: row.account_id,
    scan_id: row.scan_id,
    state: row.state as Report['state'],
    version: row.version,
    language: row.language,
    scope_summary: snapshot.scope_summary ?? 'Scope not recorded.',
    finding_versions: findingVersions.map((f) => ({
      finding_id: f.finding_id,
      version: f.finding_version,
    })),
    created_at: row.created_at,
    approved_at: row.approved_at,
    published_at: row.published_at,
    audience: 'internal_tenant',
    limitations: snapshot.limitations?.length
      ? snapshot.limitations
      : ['No limitations were recorded for this report.'],
  };
}

export function toBudget(row: BudgetRow): Budget {
  return {
    id: row.id,
    scope_kind: row.scope_kind,
    scope_id: row.scope_id,
    currency: row.currency,
    limit_micro: row.limit_micro,
    reserved_micro: row.reserved_micro,
    settled_micro: row.settled_micro,
    paused: row.paused,
    version: row.version,
  };
}

/** Opaque cursor over the stable (timestamp, id) ordering each list uses. */
export function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(`${timestamp}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { timestamp: string; id: string } | null {
  try {
    const [timestamp, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!timestamp || !id) return null;
    if (!Number.isFinite(Date.parse(timestamp))) return null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { timestamp, id };
  } catch {
    return null;
  }
}

export function toOffer(row: OfferRow): Offer {
  const catalogOffer = toCatalogOffer(row);
  return {
    id: row.id,
    venture_id: row.venture_id,
    sku: row.sku,
    version: row.version,
    promise: row.promise,
    detector_families: row.detector_families,
    inclusions: row.inclusions,
    exclusions: row.exclusions,
    prerequisites: row.prerequisites,
    acceptance: row.acceptance,
    // Price and enabled travel together with nothing in between: a client that shows a number
    // for a disabled SKU is showing a price nobody approved.
    price:
      row.price_minor !== null && row.currency !== null
        ? {
            currency: row.currency,
            amount_minor: row.price_minor,
            tax_treatment: row.tax_treatment,
          }
        : null,
    effort_band: effortBand(catalogOffer),
    enabled: row.enabled,
    approved_at: row.approved_at,
  };
}

/** The same row in the matcher's shape. The matcher is pure; this is where the row meets it. */
export function toCatalogOffer(row: OfferRow): CatalogOffer {
  return {
    id: row.id,
    sku: row.sku,
    version: row.version,
    promise: row.promise,
    detectorFamilies: row.detector_families,
    inclusions: row.inclusions,
    exclusions: row.exclusions,
    prerequisites: row.prerequisites,
    acceptance: row.acceptance,
    currency: row.currency,
    priceMinor: row.price_minor,
    taxTreatment: row.tax_treatment,
    minEffortMinutes: row.min_effort_minutes,
    maxEffortMinutes: row.max_effort_minutes,
    enabled: row.enabled,
  };
}

export function toOfferDraft(row: OfferDraftRow): OfferDraft {
  return {
    id: row.id,
    opportunity_id: row.opportunity_id,
    offer_id: row.offer_id,
    offer_sku: row.offer_sku,
    offer_version: row.offer_version,
    state: row.state as OfferDraft['state'],
    version: row.version,
    price: {
      currency: row.currency,
      amount_minor: row.price_minor,
      tax_treatment:
        typeof row.snapshot['tax_treatment'] === 'string' ? row.snapshot['tax_treatment'] : null,
    },
    snapshot: row.snapshot,
    finding_ids: row.finding_ids,
    root_cause_keys: row.root_cause_keys,
    created_by: row.created_by,
    created_at: row.created_at,
    withdrawn_at: row.withdrawn_at,
    withdraw_reason: row.withdraw_reason,
  };
}

export function toOfferPrerequisite(row: OfferPrerequisiteRow): OfferPrerequisite {
  return {
    id: row.id,
    account_id: row.account_id,
    prerequisite: row.prerequisite,
    // `note` is deliberately absent: it describes a customer relationship and belongs in the
    // audit record, not in a projection any viewer can read.
    recorded_by: row.recorded_by,
    recorded_at: row.recorded_at,
    revoked_at: row.revoked_at,
    revoke_reason: row.revoke_reason,
  };
}

/**
 * Review history.
 *
 * The reason IS the substance here — this endpoint exists so a workspace can read why a claim
 * was confirmed — but it is projected rather than passed through, so a column added to
 * `oe.reviews` later cannot ride onto the wire unnoticed.
 */
export function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    finding_id: row.finding_id,
    finding_version: row.finding_version,
    reviewer_id: row.reviewer_id,
    decision: row.decision as Review['decision'],
    reason: row.reason,
    created_at: row.created_at,
  };
}

export function toScanStep(row: ScanStepRow): ScanStep {
  return {
    id: row.id,
    step_key: row.step_key,
    state: row.state,
    attempt: row.attempt,
    provider_request_id: row.provider_request_id,
    updated_at: row.updated_at,
  };
}
