import { z } from 'zod';
import { ACCEPTED_DETECTOR_IDS, IMPLEMENTED_DETECTORS } from './detector-ids.ts';
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
    /**
     * What this deployment actually runs. The operator renders this instead of a constant
     * from its own bundle, so a stale client cannot advertise a detector the server lacks.
     */
    implemented_detectors: z.array(z.string().min(1)).min(1),
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

/**
 * Detector spellings a caller may send.
 *
 * Both namespaces: the Consistency Engine's own `CE-` ids and the venture-scoped `MF-`/`PDP-`
 * ones the handoff contract used. A client written against the handoff keeps working, because
 * widening what is accepted can break nobody. See `detector-ids.ts` for the mapping and for
 * why nothing already written down gets renamed.
 */
export const RequestedDetectorId = z.enum(
  ACCEPTED_DETECTOR_IDS as unknown as [string, ...string[]],
);
export type RequestedDetectorId = z.infer<typeof RequestedDetectorId>;

export const CreateScan = z
  .object({
    account_id: Uuid,
    venture_id: Uuid,
    target_url: z.string().max(4096),
    authorization_id: Uuid,
    max_unique_pages: z.number().int().min(1).max(5),
    detectors: z
      .array(RequestedDetectorId)
      .min(1)
      .max(IMPLEMENTED_DETECTORS.length)
      .refine((value) => new Set(value).size === value.length, {
        message: 'detectors must be unique',
      }),
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
    /**
     * What the collector recorded: status, classification, rendered outcome, timing. Only
     * fields this system produced — never page content, and never scraped text.
     */
    observation: z.record(z.string(), z.unknown()),
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
    ctx.addIssue({
      code: 'custom',
      path: ['evidence_ids'],
      message: 'confirmed finding needs evidence',
    });
  }
  if (value.reviewer_id === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['reviewer_id'],
      message: 'confirmed finding needs a reviewer',
    });
  }
  if (value.reviewed_at === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['reviewed_at'],
      message: 'confirmed finding needs a review time',
    });
  }
  if (value.evidence_grade !== 'A' && value.evidence_grade !== 'B') {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence_grade'],
      message: 'confirmed finding needs grade A or B',
    });
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

const FindingVersionRef = z.object({ finding_id: Uuid, version: z.number().int().min(1) }).strict();
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

/* --------------------------------------------------------- offer catalogue */

/**
 * A commercial price, in MINOR units.
 *
 * Deliberately not `Money`. `Money` carries provider cost in micro-units of the ledger
 * currency; this carries what a customer pays in cents of a sale currency. BUDGET_LEDGER.md
 * forbids adding the two, and giving them different field names makes a mix-up fail to parse
 * rather than quietly produce a number that is wrong by four orders of magnitude.
 */
export const OfferPrice = z
  .object({
    currency: CurrencyCode,
    amount_minor: z.string().regex(/^[0-9]+$/),
    tax_treatment: z.union([z.string(), z.null()]),
  })
  .strict();
export type OfferPrice = z.infer<typeof OfferPrice>;

export const Offer = z
  .object({
    id: Uuid,
    venture_id: Uuid,
    sku: z.string().regex(/^[A-Z0-9-]+$/),
    version: z.number().int().min(1),
    promise: z.string().min(1).max(2000),
    detector_families: z.array(z.string()).min(1),
    inclusions: z.array(z.string()),
    exclusions: z.array(z.string()),
    prerequisites: z.array(z.string()),
    acceptance: z.array(z.string()).min(1),
    /** Null until an owner approves one. A scope with no price is not sellable. */
    price: z.union([OfferPrice, z.null()]),
    effort_band: z.union([z.string(), z.null()]),
    enabled: z.boolean(),
    approved_at: z.union([DateTime, z.null()]),
  })
  .strict();
export type Offer = z.infer<typeof Offer>;

export const OfferIneligibility = z.enum([
  'no_confirmed_finding',
  'detector_not_supported_by_any_sku',
  'sku_not_enabled',
  'sku_has_no_approved_price',
  'prerequisites_unmet',
  'delivery_capacity_reached',
]);
export type OfferIneligibility = z.infer<typeof OfferIneligibility>;

export const EligibleOffer = z
  .object({
    offer: Offer,
    finding_ids: z.array(Uuid).min(1),
    root_cause_keys: z.array(z.string()).min(1),
    unmet_prerequisites: z.array(z.string()),
    draftable: z.boolean(),
  })
  .strict();
export type EligibleOffer = z.infer<typeof EligibleOffer>;

export const OfferMatch = z
  .object({
    eligible: z.array(EligibleOffer),
    rejected: z.array(z.object({ sku: z.string(), reason: OfferIneligibility }).strict()),
    route_to_manual_quotation: z.boolean(),
    capacity_reached: z.boolean(),
    open_commitments: z.number().int().min(0),
    delivery_capacity: z.number().int().min(0),
  })
  .strict();
export type OfferMatch = z.infer<typeof OfferMatch>;

export const OfferDraftState = z.enum(['draft', 'withdrawn', 'superseded']);
export type OfferDraftState = z.infer<typeof OfferDraftState>;

export const OfferDraft = z
  .object({
    id: Uuid,
    opportunity_id: Uuid,
    offer_id: Uuid,
    offer_sku: z.string(),
    offer_version: z.number().int().min(1),
    state: OfferDraftState,
    version: z.number().int().min(1),
    /** Copied at draft time. A later catalogue change must not reprice a quote already given. */
    price: OfferPrice,
    snapshot: z.record(z.string(), z.unknown()),
    finding_ids: z.array(Uuid).min(1),
    root_cause_keys: z.array(z.string()).min(1),
    created_by: Uuid,
    created_at: DateTime,
    withdrawn_at: z.union([DateTime, z.null()]),
    withdraw_reason: z.union([z.string(), z.null()]),
  })
  .strict();
export type OfferDraft = z.infer<typeof OfferDraft>;

export const OfferDrafts = z.object({ items: z.array(OfferDraft) }).strict();
export type OfferDrafts = z.infer<typeof OfferDrafts>;

/** No price field, by design: a price that did not come from an owner approval is not one. */
export const CreateOfferDraft = z.object({ offer_id: Uuid }).strict();
export type CreateOfferDraft = z.infer<typeof CreateOfferDraft>;

export const WithdrawOfferDraft = z
  .object({ expected_version: z.number().int().min(1), reason: z.string().min(1).max(2000) })
  .strict();
export type WithdrawOfferDraft = z.infer<typeof WithdrawOfferDraft>;

/**
 * A prerequisite recorded as met.
 *
 * Nothing the engine captures can establish "authorized code access" or "agreed destination".
 * Somebody has to say so, with a note explaining how they know, and stay named for saying it.
 * Revoked records are kept rather than deleted.
 */
export const OfferPrerequisite = z
  .object({
    id: Uuid,
    account_id: Uuid,
    prerequisite: z.string().min(1).max(200),
    recorded_by: Uuid,
    recorded_at: DateTime,
    revoked_at: z.union([DateTime, z.null()]),
    revoke_reason: z.union([z.string(), z.null()]),
  })
  .strict();
export type OfferPrerequisite = z.infer<typeof OfferPrerequisite>;

export const OfferPrerequisites = z.object({ items: z.array(OfferPrerequisite) }).strict();
export type OfferPrerequisites = z.infer<typeof OfferPrerequisites>;

export const RecordOfferPrerequisite = z
  .object({
    prerequisite: z.string().min(1).max(200),
    /** Required. A prerequisite recorded without a note is an assertion with nothing behind it. */
    note: z.string().min(10).max(2000),
  })
  .strict();
export type RecordOfferPrerequisite = z.infer<typeof RecordOfferPrerequisite>;

export const RevokeOfferPrerequisite = z
  .object({
    prerequisite: z.string().min(1).max(200),
    reason: z.string().min(1).max(2000),
  })
  .strict();
export type RevokeOfferPrerequisite = z.infer<typeof RevokeOfferPrerequisite>;

/* ------------------------------------------------- operator read surfaces */

export const ScanStep = z
  .object({
    id: Uuid,
    step_key: z.string(),
    state: z.string(),
    attempt: z.number().int().min(0),
    provider_request_id: z.union([z.string(), z.null()]),
    updated_at: DateTime,
  })
  .strict();
export type ScanStep = z.infer<typeof ScanStep>;

export const ScanTimeline = z
  .object({
    steps: z.array(ScanStep),
    evidence: z.array(Evidence),
    findings: z.array(Finding),
  })
  .strict();
export type ScanTimeline = z.infer<typeof ScanTimeline>;

/** One decision, bound to the finding version it was made against. Never edited. */
export const Review = z
  .object({
    id: Uuid,
    finding_id: Uuid,
    finding_version: z.number().int().min(1),
    reviewer_id: Uuid,
    decision: z.enum(['confirm', 'reject', 'unknown']),
    reason: z.string().min(1).max(2000),
    created_at: DateTime,
  })
  .strict();
export type Review = z.infer<typeof Review>;

export const Reviews = page(Review);
export type Reviews = z.infer<typeof Reviews>;
export const Authorizations = page(Authorization);
export type Authorizations = z.infer<typeof Authorizations>;

/* --------------------------------------------------------- requested intake */

export const IntakeForm = z
  .object({
    host: z.string(),
    /** What a requester must be shown before submitting. Minimum length is the contract. */
    purpose_text: z.string().min(40),
    purpose_version: z.number().int().min(1),
    allowed_detectors: z.array(z.string()).min(1),
  })
  .strict();
export type IntakeForm = z.infer<typeof IntakeForm>;

/**
 * A request for a check.
 *
 * Note what is absent: no tenant, no venture, no account, no price. The workspace comes from
 * the host the request arrives on. BUILD_SPEC.md §14: "Clients never choose a tenant by
 * sending an arbitrary trusted body field."
 */
export const SubmitIntakeRequest = z
  .object({
    target_url: z.string().min(8).max(2000),
    requested_detectors: z.array(z.string()).min(1).max(IMPLEMENTED_DETECTORS.length),
    purpose: z.string().min(10).max(2000),
    /** Recorded as a claim, never treated as proof of authority over the target. */
    authority_claim: z.string().min(10).max(2000),
    contact_email: z.string().email().min(5).max(320),
  })
  .strict();
export type SubmitIntakeRequest = z.infer<typeof SubmitIntakeRequest>;

export const VerifyIntakeRequest = z.object({ code: z.string().regex(/^[0-9]{6}$/) }).strict();
export type VerifyIntakeRequest = z.infer<typeof VerifyIntakeRequest>;

/** Coarse on purpose: `closed` covers both declined and expired. */
export const PublicIntakeState = z.enum(['pending', 'received', 'closed']);
export type PublicIntakeState = z.infer<typeof PublicIntakeState>;

export const PublicIntakeRequest = z
  .object({
    id: Uuid,
    state: PublicIntakeState,
    target_url: z.string(),
    requested_detectors: z.array(z.string()),
    submitted_at: DateTime,
    expires_at: DateTime,
    /** Non-null only under the local fixture channel, which sends nothing. */
    local_verification_code: z.union([z.string(), z.null()]),
    delivery_detail: z.union([z.string(), z.null()]),
  })
  .strict();
export type PublicIntakeRequest = z.infer<typeof PublicIntakeRequest>;

export const IntakeRequestState = z.enum([
  'pending_verification',
  'verified',
  'declined',
  'expired',
  'converted',
]);
export type IntakeRequestState = z.infer<typeof IntakeRequestState>;

export const IntakeRequest = z
  .object({
    id: Uuid,
    channel_id: Uuid,
    venture_id: Uuid,
    target_url: z.string(),
    target_host: z.string(),
    requested_detectors: z.array(z.string()),
    purpose: z.string(),
    authority_claim: z.string(),
    agreed_purpose_version: z.number().int().min(1),
    /** Null for a viewer. Answering a request needs the address; browsing the queue does not. */
    contact_email: z.union([z.string(), z.null()]),
    marketing_consent: z.boolean(),
    state: IntakeRequestState,
    version: z.number().int().min(1),
    verified_at: z.union([DateTime, z.null()]),
    decided_at: z.union([DateTime, z.null()]),
    decision_reason: z.union([z.string(), z.null()]),
    account_id: z.union([Uuid, z.null()]),
    submitted_at: DateTime,
    expires_at: DateTime,
  })
  .strict();
export type IntakeRequest = z.infer<typeof IntakeRequest>;

export const IntakeRequests = page(IntakeRequest);
export type IntakeRequests = z.infer<typeof IntakeRequests>;

export const IntakeChannel = z
  .object({
    id: Uuid,
    venture_id: Uuid,
    host: z.string(),
    enabled: z.boolean(),
    purpose_text: z.string(),
    purpose_version: z.number().int().min(1),
    allowed_detectors: z.array(z.string()),
    daily_request_limit: z.number().int().min(0),
  })
  .strict();
export type IntakeChannel = z.infer<typeof IntakeChannel>;

export const IntakeChannels = z.object({ items: z.array(IntakeChannel) }).strict();
export type IntakeChannels = z.infer<typeof IntakeChannels>;

export const SetIntakeChannelEnabled = z.object({ enabled: z.boolean() }).strict();
export type SetIntakeChannelEnabled = z.infer<typeof SetIntakeChannelEnabled>;

export const DeclineIntakeRequest = z
  .object({
    expected_version: z.number().int().min(1),
    reason: z.string().min(1).max(2000),
  })
  .strict();
export type DeclineIntakeRequest = z.infer<typeof DeclineIntakeRequest>;

/* ------------------------------------------------------ report delivery */

export const ReportGrantState = z.enum(['live', 'expired', 'revoked']);
export type ReportGrantState = z.infer<typeof ReportGrantState>;

/**
 * A link to one report version, for one recipient, for a bounded time.
 *
 * Not a membership. ACCESS_MODEL.md: giving a client a viewer seat so they can read their own
 * case "is the single most likely way this system leaks one customer's data to another". A
 * grant opens that version and nothing else — not the scan, not the evidence artifacts, not
 * the account, not another report.
 *
 * The token is deliberately absent from this shape. It exists once, in `IssuedReportGrant`.
 */
export const ReportGrant = z
  .object({
    id: Uuid,
    report_id: Uuid,
    report_version: z.number().int().min(1),
    recipient_note: z.string(),
    expires_at: DateTime,
    revoked_at: z.union([DateTime, z.null()]),
    revoke_reason: z.union([z.string(), z.null()]),
    created_by: Uuid,
    created_at: DateTime,
    state: ReportGrantState,
  })
  .strict();
export type ReportGrant = z.infer<typeof ReportGrant>;

/** The one response carrying the token. No operation can return it a second time. */
export const IssuedReportGrant = z
  .object({ grant: ReportGrant, token: z.string(), url: z.string() })
  .strict();
export type IssuedReportGrant = z.infer<typeof IssuedReportGrant>;

export const ReportGrants = z.object({ items: z.array(ReportGrant) }).strict();
export type ReportGrants = z.infer<typeof ReportGrants>;

/**
 * No expiry field, and no address field.
 *
 * The lifetime is the server's, so a link cannot be issued that outlives what anybody decided.
 * `recipient_ref` is opaque-keyed before storage and never read back; `recipient_note` is the
 * human label an operator sees in the list.
 */
export const IssueReportGrant = z
  .object({
    recipient_note: z.string().min(3).max(200),
    recipient_ref: z.string().min(3).max(320),
  })
  .strict();
export type IssueReportGrant = z.infer<typeof IssueReportGrant>;

export const RevokeReportGrant = z.object({ reason: z.string().min(1).max(2000) }).strict();
export type RevokeReportGrant = z.infer<typeof RevokeReportGrant>;

/**
 * What the holder of a link may read.
 *
 * The rendered body as it was published, and nothing that would let them reach anything else:
 * no account id, no scan id, no evidence ids, no artifact URLs, no reviewer identity.
 */
export const DeliveredReport = z
  .object({
    report_version: z.number().int().min(1),
    language: ReportLanguage,
    published_at: z.union([DateTime, z.null()]),
    expires_at: DateTime,
    body: z.record(z.string(), z.unknown()),
  })
  .strict();
export type DeliveredReport = z.infer<typeof DeliveredReport>;

/* ---------------------------------------------------------- engagements */

export const EngagementState = z.enum([
  'draft',
  'awaiting_acceptance',
  'awaiting_prerequisites',
  'ready',
  'in_progress',
  'awaiting_verification',
  'accepted',
  'change_requested',
  'disputed',
  'cancelled',
  'closed',
]);
export type EngagementState = z.infer<typeof EngagementState>;

/**
 * Work somebody agreed to buy, against one drafted scope.
 *
 * There is no scope field. A draft is immutable, so a changed scope means a new draft and a
 * new engagement — which is what WORKFLOWS.md means by "scope change creates a new approved
 * version", and why `change_requested` leads back to `draft` rather than onward.
 */
export const Engagement = z
  .object({
    id: Uuid,
    opportunity_id: Uuid,
    account_id: Uuid,
    offer_draft_id: Uuid,
    state: EngagementState,
    version: z.number().int().min(1),
    /** A time, a note saying how acceptance was obtained, and the member attesting to it. */
    accepted_at: z.union([DateTime, z.null()]),
    acceptance_note: z.union([z.string(), z.null()]),
    accepted_by: z.union([Uuid, z.null()]),
    side_reason: z.union([z.string(), z.null()]),
    side_owner: z.union([Uuid, z.null()]),
    created_by: Uuid,
    created_at: DateTime,
    updated_at: DateTime,
  })
  .strict();
export type Engagement = z.infer<typeof Engagement>;

export const Engagements = z.object({ items: z.array(Engagement) }).strict();
export type Engagements = z.infer<typeof Engagements>;

export const CreateEngagement = z.object({ opportunity_id: Uuid, offer_draft_id: Uuid }).strict();
export type CreateEngagement = z.infer<typeof CreateEngagement>;

/**
 * `acceptance_note` is required exactly on the transition that first leaves the
 * pre-acceptance states, and refused on every other. Sending it where it does not belong is
 * an error rather than ignored, so nobody believes they recorded an acceptance that is not
 * there.
 */
export const AdvanceEngagement = z
  .object({
    expected_version: z.number().int().min(1),
    next_state: EngagementState,
    reason: z.string().min(1).max(2000),
    acceptance_note: z.union([z.string().min(10).max(2000), z.null()]).optional(),
  })
  .strict();
export type AdvanceEngagement = z.infer<typeof AdvanceEngagement>;

/** One transition, append-only. The state says where; this says how it got there. */
export const EngagementEvent = z
  .object({
    id: Uuid,
    engagement_id: Uuid,
    from_state: EngagementState,
    to_state: EngagementState,
    to_version: z.number().int().min(1),
    reason: z.string(),
    actor_id: Uuid,
    created_at: DateTime,
  })
  .strict();
export type EngagementEvent = z.infer<typeof EngagementEvent>;

export const PaymentKind = z.enum([
  'invoice_issued',
  'payment_received',
  'refund_issued',
  'written_off',
]);
export type PaymentKind = z.infer<typeof PaymentKind>;

/**
 * What somebody typed about money.
 *
 * No card data, no processor token, no webhook. It moves no state: a payment is evidence that
 * money arrived, not evidence that work was accepted, and WORKFLOWS.md rules out conflating
 * the two.
 */
export const PaymentRecord = z
  .object({
    id: Uuid,
    engagement_id: Uuid,
    kind: PaymentKind,
    amount: OfferPrice,
    external_ref: z.string(),
    note: z.string(),
    occurred_at: DateTime,
    recorded_by: Uuid,
    recorded_at: DateTime,
  })
  .strict();
export type PaymentRecord = z.infer<typeof PaymentRecord>;

export const RecordPayment = z
  .object({
    kind: PaymentKind,
    currency: CurrencyCode,
    amount_minor: z.string().regex(/^[0-9]+$/),
    external_ref: z.string().min(1).max(200),
    note: z.string().min(1).max(2000),
    occurred_at: DateTime,
  })
  .strict();
export type RecordPayment = z.infer<typeof RecordPayment>;

export const EngagementDetail = z
  .object({
    engagement: Engagement,
    events: z.array(EngagementEvent),
    payments: z.array(PaymentRecord),
  })
  .strict();
export type EngagementDetail = z.infer<typeof EngagementDetail>;

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
  OfferPrice,
  Offer,
  EligibleOffer,
  OfferMatch,
  OfferDraft,
  OfferDrafts,
  CreateOfferDraft,
  WithdrawOfferDraft,
  OfferPrerequisite,
  OfferPrerequisites,
  RecordOfferPrerequisite,
  RevokeOfferPrerequisite,
  ScanStep,
  ScanTimeline,
  Review,
  Reviews,
  Authorizations,
  IntakeForm,
  SubmitIntakeRequest,
  VerifyIntakeRequest,
  PublicIntakeRequest,
  IntakeRequest,
  IntakeRequests,
  IntakeChannel,
  IntakeChannels,
  SetIntakeChannelEnabled,
  DeclineIntakeRequest,
  ReportGrant,
  IssuedReportGrant,
  ReportGrants,
  IssueReportGrant,
  RevokeReportGrant,
  DeliveredReport,
  EngagementState,
  Engagement,
  Engagements,
  CreateEngagement,
  AdvanceEngagement,
  EngagementEvent,
  EngagementDetail,
  PaymentRecord,
  RecordPayment,
} as const;
