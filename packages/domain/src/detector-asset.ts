/**
 * MF-ASSET-01 · product image fails to load.
 *
 * `contracts/detectors.json` fixes the bar: "Resource failure plus actual rendered-image
 * failure after bounded lazy-load wait", abstaining on `blocked`, `pending_lazy_load`,
 * `decorative_image` and `variant_changed`.
 *
 * Both halves are required. A failed request alone could still paint from cache; a blank
 * render alone could be a layout or format problem rather than a missing asset. Only the pair,
 * repeated across independent comparable sessions, supports a claim — and even then a reviewer
 * decides, exactly as for MF-LINK-01.
 *
 * Deterministic: fetches nothing, renders nothing, approves nothing.
 */

export const ASSET_DETECTOR_ID = 'MF-ASSET-01';
export const ASSET_DETECTOR_VERSION = '2.0.0';

/**
 * Detectors this build actually implements, in one place.
 *
 * `contracts/detectors.json` also specifies MF-DATA-01, PDP-CONTENT-01, PDP-VISUAL-01 and
 * PDP-MOBILE-01. Specified is not implemented: admission, the database constraint and the
 * request contract all derive from this list, so a detector cannot be requested until it
 * exists.
 */
export const IMPLEMENTED_DETECTORS = ['MF-LINK-01', 'MF-ASSET-01'] as const;
export type ImplementedDetector = (typeof IMPLEMENTED_DETECTORS)[number];

export type ImageRole = 'product' | 'decorative' | 'unknown';

/** One image, as one clean session recorded it. */
export interface ImageObservation {
  sessionId: string;
  evidenceId: string;
  capturedAt: string;
  /** Absolute URL of the image. Two observations must name the same one. */
  target: string;
  /** Page state the image was observed in: variant, viewport, locale. */
  contextKey: string;
  role: ImageRole;
  /** HTTP status of the image request; null when no response arrived. */
  resourceStatus: number | null;
  /** Bytes received. Zero with a 2xx is a successful request that carries no image. */
  resourceByteLength: number | null;
  /** Did the browser actually paint it: naturalWidth and naturalHeight both above zero. */
  rendered: boolean;
  /** The request was still outstanding when the bounded wait expired. */
  timedOut: boolean;
  /** The page asked the browser to defer this image. */
  lazy: boolean;
  /** The whole page capture completed within its limits. */
  pageComplete: boolean;
  challenge: boolean;
  loginWall: boolean;
}

export interface AssetDetectorInput {
  /** The image under test; every observation must name it. */
  target: string;
  observations: ImageObservation[];
  now: string;
  maxAgeMs?: number;
}

export type AssetDetectorResult =
  | {
      result: 'unknown';
      reason: AssetAbstention;
      evidence_ids: string[];
      proposed_grade: null;
      limitations: string[];
    }
  | {
      result: 'no_finding';
      reason: 'image_loaded_in_recorded_checks';
      evidence_ids: string[];
      proposed_grade: null;
      limitations: string[];
    }
  | {
      result: 'candidate';
      reason: AssetFailureKind;
      detector_id: string;
      detector_version: string;
      claim: string;
      evidence_ids: string[];
      proposed_grade: 'A';
      requires_human_review: true;
      limitations: string[];
    };

export type AssetAbstention =
  | 'insufficient_independent_captures'
  | 'invalid_capture_record'
  | 'incomplete_or_ambiguous_capture'
  | 'blocked'
  | 'decorative_image'
  | 'role_not_established'
  | 'pending_lazy_load'
  | 'variant_changed'
  | 'noncomparable_context'
  | 'stale_or_future_capture'
  | 'invalid_freshness_policy'
  | 'inconsistent_failure_kind'
  | 'rendered_without_resource_evidence'
  | 'resource_failure_without_render_failure';

/** Why the image did not appear. Recorded so a repair has somewhere to start. */
export type AssetFailureKind = 'resource_error_status' | 'empty_response_body' | 'no_response';

const BASE_LIMITATIONS = [
  'Only this image, in the recorded product state and viewport, was tested.',
  'Store-wide scope and revenue impact are unknown.',
];

const abstain = (reason: AssetAbstention, evidenceIds: string[] = []): AssetDetectorResult => ({
  result: 'unknown',
  reason,
  evidence_ids: evidenceIds,
  proposed_grade: null,
  limitations: [
    'This rule does not measure revenue impact or whole-store health.',
    ...BASE_LIMITATIONS,
  ],
});

export function evaluateProductImage(input: AssetDetectorInput): AssetDetectorResult {
  if (!input || typeof input.target !== 'string' || !input.target.trim()) {
    return abstain('invalid_capture_record');
  }
  if (!Array.isArray(input.observations) || input.observations.length < 2) {
    return abstain('insufficient_independent_captures');
  }
  const obs = input.observations;

  if (
    obs.some(
      (o) =>
        !o ||
        typeof o.sessionId !== 'string' ||
        !o.sessionId.trim() ||
        typeof o.evidenceId !== 'string' ||
        !o.evidenceId.trim() ||
        !Number.isFinite(Date.parse(o.capturedAt)) ||
        o.target !== input.target ||
        typeof o.contextKey !== 'string' ||
        !o.contextKey.trim(),
    )
  ) {
    return abstain('invalid_capture_record');
  }
  const evidenceIds = obs.map((o) => o.evidenceId);

  // Two independent sessions, not one request recorded twice.
  if (new Set(obs.map((o) => o.sessionId)).size < 2 || new Set(evidenceIds).size < 2) {
    return abstain('insufficient_independent_captures', evidenceIds);
  }

  // An access challenge or a login wall means the page never answered for us.
  if (obs.some((o) => o.challenge || o.loginWall)) return abstain('blocked', evidenceIds);
  if (obs.some((o) => !o.pageComplete))
    return abstain('incomplete_or_ambiguous_capture', evidenceIds);

  // A decorative image carries no product information, so its absence is not this claim.
  if (obs.some((o) => o.role === 'decorative')) return abstain('decorative_image', evidenceIds);
  if (obs.some((o) => o.role !== 'product')) return abstain('role_not_established', evidenceIds);

  // The product state must match, or the two observations are of different things.
  if (new Set(obs.map((o) => o.contextKey)).size !== 1) {
    // Name the common case specifically: a page that served a different variant.
    const variants = new Set(obs.map((o) => o.contextKey.split('|')[1] ?? ''));
    return abstain(variants.size > 1 ? 'variant_changed' : 'noncomparable_context', evidenceIds);
  }

  const now = Date.parse(input.now);
  const freshMs = input.maxAgeMs ?? 86_400_000;
  if (!Number.isFinite(now) || !Number.isSafeInteger(freshMs) || freshMs < 1) {
    return abstain('invalid_freshness_policy', evidenceIds);
  }
  if (obs.some((o) => Date.parse(o.capturedAt) > now || now - Date.parse(o.capturedAt) > freshMs)) {
    return abstain('stale_or_future_capture', evidenceIds);
  }

  // The bounded wait expired with the request still outstanding. A slow image is not a
  // broken one, and this rule refuses to confuse them.
  if (obs.some((o) => o.timedOut)) return abstain('pending_lazy_load', evidenceIds);

  if (obs.every((o) => o.rendered)) {
    return {
      result: 'no_finding',
      reason: 'image_loaded_in_recorded_checks',
      evidence_ids: evidenceIds,
      proposed_grade: null,
      limitations: ['Only this image and its recorded conditions were tested.'],
    };
  }
  // Painted in one session and not the other: unresolved, not a defect.
  if (obs.some((o) => o.rendered)) return abstain('inconsistent_failure_kind', evidenceIds);

  const kinds = obs.map(failureKind);
  if (kinds.some((kind) => kind === null)) {
    // It did not render, but the request succeeded and returned a body. The cause could be
    // styling, an unsupported format or a decoding failure — none of which this rule tests.
    return abstain('rendered_without_resource_evidence', evidenceIds);
  }
  if (new Set(kinds).size !== 1) return abstain('inconsistent_failure_kind', evidenceIds);

  const kind = kinds[0]!;
  const status = obs[0]!.resourceStatus;
  if (kind === 'resource_error_status' && new Set(obs.map((o) => o.resourceStatus)).size !== 1) {
    return abstain('inconsistent_failure_kind', evidenceIds);
  }

  return {
    result: 'candidate',
    reason: kind,
    detector_id: ASSET_DETECTOR_ID,
    detector_version: ASSET_DETECTOR_VERSION,
    claim: claimFor(kind, status, obs.length),
    evidence_ids: evidenceIds,
    proposed_grade: 'A',
    requires_human_review: true,
    limitations: BASE_LIMITATIONS,
  };
}

/**
 * How the request failed, or null when it did not fail. `null` is what separates "the asset is
 * missing" from "the asset arrived and something else went wrong".
 */
function failureKind(observation: ImageObservation): AssetFailureKind | null {
  const { resourceStatus: status, resourceByteLength: bytes } = observation;
  if (status === null) return 'no_response';
  if (status >= 400) return 'resource_error_status';
  if (status >= 200 && status < 300 && bytes === 0) return 'empty_response_body';
  return null;
}

function claimFor(kind: AssetFailureKind, status: number | null, checks: number): string {
  const suffix = `in ${checks} recorded checks.`;
  switch (kind) {
    case 'resource_error_status':
      return `The product image did not load ${suffix} Its request returned HTTP ${status}.`;
    case 'empty_response_body':
      return `The product image did not load ${suffix} Its request returned HTTP ${status} with an empty body.`;
    case 'no_response':
      return `The product image did not load ${suffix} No response was received for it.`;
  }
}

/**
 * Classify one image as product content, decoration, or not established.
 *
 * Deliberately asymmetric: `product` needs a positive signal, everything ambiguous stays
 * `unknown`, and the detector abstains on anything that is not `product`. A broken image with
 * no alt text is therefore missed rather than asserted — the right trade when the alternative
 * is telling a merchant their product photo is broken because a spacer GIF 404'd.
 */
export function classifyImage(input: {
  /** The attribute's value, or null when the attribute is absent entirely. */
  alt: string | null;
  presentational: boolean;
  insideMain: boolean;
}): { role: ImageRole; reason: string } {
  if (input.presentational) return { role: 'decorative', reason: 'marked_presentational' };
  if (input.alt === '') return { role: 'decorative', reason: 'empty_alt_text' };
  if (input.alt === null) return { role: 'unknown', reason: 'no_alt_attribute' };
  if (!input.insideMain) return { role: 'unknown', reason: 'outside_main_content' };
  return { role: 'product', reason: 'described_image_in_main_content' };
}
