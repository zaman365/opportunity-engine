import { z } from 'zod';
import {
  CurrencyCode,
  DateTime,
  Environment,
  ExpectedVersion,
  Health,
  MicroAmount,
  Money,
  Problem,
  Role,
  Uuid,
  page,
} from './primitives.ts';

export const Session = z
  .object({
    subject: z.string().min(1),
    active_tenant_id: Uuid,
    role: Role,
    venture_ids: z.array(Uuid),
    csrf_token: z.string().min(20),
    environment: Environment,
  })
  .strict();
export type Session = z.infer<typeof Session>;

export const CreateAccount = z
  .object({
    name: z.string().min(1).max(200),
    canonical_domain: z.string().regex(/^[a-z0-9.-]+$/),
    venture_id: Uuid,
    approved_hosts: z.array(z.string().min(1).max(253)).min(1),
    source_note: z.string().min(1).max(2000),
  })
  .strict()
  .refine((v) => new Set(v.approved_hosts).size === v.approved_hosts.length, {
    message: 'approved_hosts must be unique',
    path: ['approved_hosts'],
  });
export type CreateAccount = z.infer<typeof CreateAccount>;

export const Account = z
  .object({
    id: Uuid,
    name: z.string().min(1),
    canonical_domain: z.string().min(1),
    venture_id: Uuid,
    approved_hosts: z.array(z.string().min(1)),
    version: z.number().int().min(1),
    created_at: DateTime,
  })
  .strict();
export type Account = z.infer<typeof Account>;

export const AuthorizationAction = z.enum(['scan_public', 'publish_internal_report']);
export type AuthorizationAction = z.infer<typeof AuthorizationAction>;

export const AuthorizationInput = z
  .object({
    action: AuthorizationAction,
    purpose: z.string().min(1).max(2000),
    evidence_note: z.string().min(1).max(2000),
    expires_at: DateTime,
    policy_version: z.string().min(1),
  })
  .strict();
export type AuthorizationInput = z.infer<typeof AuthorizationInput>;

export const Authorization = z
  .object({
    id: Uuid,
    account_id: Uuid,
    action: AuthorizationAction,
    expires_at: DateTime,
    revoked_at: z.union([DateTime, z.null()]),
    policy_version: z.string().min(1),
  })
  .strict();
export type Authorization = z.infer<typeof Authorization>;

export const DetectorId = z.literal('MF-LINK-01');

export const CreateScan = z
  .object({
    account_id: Uuid,
    venture_id: Uuid,
    target_url: z.string().max(4096),
    authorization_id: Uuid,
    max_unique_pages: z.number().int().min(1).max(5),
    detectors: z.array(DetectorId).min(1).max(1),
    max_cost: Money,
  })
  .strict();
export type CreateScan = z.infer<typeof CreateScan>;

export const ScanState = z.enum([
  'queued',
  'validating',
  'capturing',
  'analysing',
  'cancel_requested',
  'succeeded',
  'partial',
  'blocked',
  'failed',
  'cancelled',
]);
export type ScanState = z.infer<typeof ScanState>;

export const ScanCoverage = z
  .object({
    expected_unique_pages: z.number().int().min(1).max(5),
    captured_unique_pages: z.number().int().min(0).max(5),
    complete_checks: z.number().int().min(0),
    reasons: z.array(z.string().min(1)),
  })
  .strict();
export type ScanCoverage = z.infer<typeof ScanCoverage>;

export const ScanCost = z
  .object({
    cap: Money,
    settled: Money,
    reserved: Money,
    settlement_uncertain: z.boolean(),
  })
  .strict();
export type ScanCost = z.infer<typeof ScanCost>;

export const Scan = z
  .object({
    id: Uuid,
    account_id: Uuid,
    venture_id: Uuid,
    state: ScanState,
    version: z.number().int().min(1),
    target_url: z.string(),
    created_at: DateTime,
    updated_at: DateTime,
    coverage: ScanCoverage,
    cost: ScanCost,
    evidence_ids: z.array(Uuid),
    finding_ids: z.array(Uuid),
    blocked_reason: z.union([z.string().min(1).max(2000), z.null()]),
  })
  .strict();
export type Scan = z.infer<typeof Scan>;

export const CaptureConditions = z
  .object({
    captured_at: DateTime,
    session_id: z.string().min(1),
    viewport_width: z.number().int().min(1),
    viewport_height: z.number().int().min(1),
    locale: z.string().min(2),
    variant: z.union([z.string().min(1), z.null()]),
    consent_state: z.string().min(1),
    browser_version: z.string().min(1),
    test_region: z.union([z.string().min(1), z.null()]),
  })
  .strict();
export type CaptureConditions = z.infer<typeof CaptureConditions>;

export const EvidenceKind = z.enum(['screenshot', 'http_observation', 'dom_observation']);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const Evidence = z
  .object({
    id: Uuid,
    scan_id: Uuid,
    asset_id: Uuid,
    source_url: z.string(),
    final_url: z.string(),
    kind: EvidenceKind,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    conditions: CaptureConditions,
    http_status: z.union([z.number().int().min(100).max(599), z.null()]),
    complete: z.boolean(),
    expires_at: DateTime,
    content_available: z.boolean(),
    redacted: z.boolean(),
  })
  .strict();
export type Evidence = z.infer<typeof Evidence>;

export const FindingState = z.enum(['candidate', 'confirmed', 'rejected', 'unknown', 'stale']);
export type FindingState = z.infer<typeof FindingState>;

export const EvidenceGrade = z.enum(['A', 'B', 'C']);
export type EvidenceGrade = z.infer<typeof EvidenceGrade>;

export const CommercialImpact = z.enum([
  'unknown',
  'hypothesis',
  'measured_noncausal',
  'validated_causal',
]);
export type CommercialImpact = z.infer<typeof CommercialImpact>;

const FindingShape = z
  .object({
    id: Uuid,
    scan_id: Uuid,
    asset_id: Uuid,
    detector_id: z.string().min(1),
    detector_version: z.string().min(1),
    state: FindingState,
    version: z.number().int().min(1),
    root_cause_key: z.string().min(1),
    claim: z.string().min(1).max(2000),
    evidence_ids: z.array(Uuid),
    contrary_evidence_ids: z.array(Uuid),
    scope: z.string().min(1).max(2000),
    limitations: z.array(z.string().min(1).max(2000)).min(1),
    evidence_grade: z.union([EvidenceGrade, z.null()]),
    commercial_impact: CommercialImpact,
    captured_at: DateTime,
    reviewer_id: z.union([Uuid, z.null()]),
    reviewed_at: z.union([DateTime, z.null()]),
  })
  .strict();

/**
 * The contract's conditional clause: a confirmed finding must carry supporting evidence,
 * a bound reviewer and an A/B grade. Enforced here so an unreviewed row cannot be
 * serialised as confirmed by accident.
 */
export const Finding = FindingShape.superRefine((value, ctx) => {
  if (value.state !== 'confirmed') return;
  if (value.evidence_ids.length < 1) {
    ctx.addIssue({ code: 'custom', path: ['evidence_ids'], message: 'confirmed finding needs evidence' });
  }
  if (value.reviewer_id === null) {
    ctx.addIssue({ code: 'custom', path: ['reviewer_id'], message: 'confirmed finding needs a reviewer' });
  }
  if (value.reviewed_at === null) {
    ctx.addIssue({ code: 'custom', path: ['reviewed_at'], message: 'confirmed finding needs a review time' });
  }
  if (value.evidence_grade !== 'A' && value.evidence_grade !== 'B') {
    ctx.addIssue({ code: 'custom', path: ['evidence_grade'], message: 'confirmed finding needs grade A or B' });
  }
});
export type Finding = z.infer<typeof Finding>;

export const ReviewDecision = z.enum(['confirm', 'reject', 'unknown']);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

export const ReviewFinding = z
  .object({
    expected_version: z.number().int().min(1),
    decision: ReviewDecision,
    reason: z.string().min(5).max(2000),
    acknowledged_limitations: z.literal(true),
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFinding>;

const PriorityComponent = z
  .object({
    weight: z.number().int().min(0).max(100),
    value: z.union([z.number().min(0).max(1), z.null()]),
    contribution: z.union([z.number().min(0).max(100), z.null()]),
  })
  .strict();

export const PriorityDimension = z.enum(['fit', 'need', 'deliverability', 'timing', 'value']);
export type PriorityDimension = z.infer<typeof PriorityDimension>;

export const PriorityScore = z
  .object({
    modelVersion: z.literal('priority-v1'),
    pointScore: z.union([z.number().min(0).max(100), z.null()]),
    lowerBound: z.number().min(0).max(100),
    upperBound: z.number().min(0).max(100),
    weightedCoverage: z.number().min(0).max(1),
    rankable: z.boolean(),
    unknown: z.array(PriorityDimension),
    components: z
      .object({
        fit: PriorityComponent,
        need: PriorityComponent,
        deliverability: PriorityComponent,
        timing: PriorityComponent,
        value: PriorityComponent,
      })
      .strict(),
    interpretation: z.string().min(1),
  })
  .strict();
export type PriorityScore = z.infer<typeof PriorityScore>;

export const PermissionState = z.enum([
  'research_only',
  'review_allowed',
  'action_allowed',
  'blocked',
]);
export type PermissionState = z.infer<typeof PermissionState>;

export const NextAction = z.enum([
  'review_evidence',
  'request_access',
  'revalidate',
  'draft_offer',
  'none',
]);
export type NextAction = z.infer<typeof NextAction>;

export const Opportunity = z
  .object({
    id: Uuid,
    account: Account,
    venture_id: Uuid,
    finding_ids: z.array(Uuid),
    title: z.string().min(1).max(2000),
    priority: z.union([PriorityScore, z.null()]),
    permission_state: PermissionState,
    next_action: NextAction,
    owner_id: z.union([Uuid, z.null()]),
    updated_at: DateTime,
  })
  .strict();
export type Opportunity = z.infer<typeof Opportunity>;

const FindingVersionRef = z
  .object({ finding_id: Uuid, version: z.number().int().min(1) })
  .strict();
export type FindingVersionRef = z.infer<typeof FindingVersionRef>;

export const ReportLanguage = z.enum(['en', 'de']);
export type ReportLanguage = z.infer<typeof ReportLanguage>;

export const CreateReport = z
  .object({
    account_id: Uuid,
    scan_id: Uuid,
    finding_versions: z.array(FindingVersionRef),
    language: ReportLanguage,
    scope_summary: z.string().min(1).max(2000),
  })
  .strict();
export type CreateReport = z.infer<typeof CreateReport>;

export const ReportState = z.enum(['draft', 'approved', 'published', 'revoked', 'superseded']);
export type ReportState = z.infer<typeof ReportState>;

export const Report = z
  .object({
    id: Uuid,
    account_id: Uuid,
    scan_id: Uuid,
    state: ReportState,
    version: z.number().int().min(1),
    language: ReportLanguage,
    scope_summary: z.string().min(1).max(2000),
    finding_versions: z.array(FindingVersionRef),
    created_at: DateTime,
    approved_at: z.union([DateTime, z.null()]),
    published_at: z.union([DateTime, z.null()]),
    audience: z.literal('internal_tenant'),
    limitations: z.array(z.string().min(1).max(2000)).min(1),
  })
  .strict();
export type Report = z.infer<typeof Report>;

export const BudgetScopeKind = z.enum(['tenant', 'venture', 'scan']);
export type BudgetScopeKind = z.infer<typeof BudgetScopeKind>;

export const Budget = z
  .object({
    id: Uuid,
    scope_kind: BudgetScopeKind,
    scope_id: Uuid,
    currency: CurrencyCode,
    limit_micro: MicroAmount,
    reserved_micro: MicroAmount,
    settled_micro: MicroAmount,
    paused: z.boolean(),
    version: z.number().int().min(1),
  })
  .strict();
export type Budget = z.infer<typeof Budget>;

export const ChangeBudget = z
  .object({
    expected_version: z.number().int().min(1),
    limit: Money,
    reason: z.string().min(5).max(2000),
  })
  .strict();
export type ChangeBudget = z.infer<typeof ChangeBudget>;

export const PauseBudget = z
  .object({
    expected_version: z.number().int().min(1),
    paused: z.boolean(),
    reason: z.string().min(5).max(2000),
  })
  .strict();
export type PauseBudget = z.infer<typeof PauseBudget>;

export const FindingDetail = z.object({ finding: Finding, evidence: z.array(Evidence) }).strict();
export type FindingDetail = z.infer<typeof FindingDetail>;

export const OpportunityDetail = z
  .object({
    opportunity: Opportunity,
    findings: z.array(Finding),
    evidence: z.array(Evidence),
  })
  .strict();
export type OpportunityDetail = z.infer<typeof OpportunityDetail>;

export const Accounts = page(Account);
export type Accounts = z.infer<typeof Accounts>;
export const Scans = page(Scan);
export type Scans = z.infer<typeof Scans>;
export const Opportunities = page(Opportunity);
export type Opportunities = z.infer<typeof Opportunities>;
export const Budgets = page(Budget);
export type Budgets = z.infer<typeof Budgets>;

export { ExpectedVersion };

/** Name → schema, keyed exactly as the OpenAPI `components.schemas` map. */
export const componentSchemas = {
  Money,
  Problem,
  Role,
  Session,
  CreateAccount,
  Account,
  AuthorizationInput,
  Authorization,
  CreateScan,
  Scan,
  CaptureConditions,
  Evidence,
  Finding,
  ReviewFinding,
  PriorityScore,
  Opportunity,
  ExpectedVersion,
  CreateReport,
  Report,
  Budget,
  ChangeBudget,
  PauseBudget,
  Health,
  Accounts,
  Scans,
  Opportunities,
  Budgets,
  FindingDetail,
  OpportunityDetail,
} as const;
