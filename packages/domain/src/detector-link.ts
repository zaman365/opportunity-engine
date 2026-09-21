/**
 * MF-LINK-01 · narrow broken-information-link observation rule.
 *
 * Deterministic. It fetches nothing and approves nothing: a `candidate` result still
 * requires a human reviewer bound to the finding version before it can reach a report.
 * Ported from `reference/detector-link.mjs`; parity is asserted in tests.
 */

export const DETECTOR_ID = 'MF-LINK-01';
export const DETECTOR_VERSION = '2.0.0';

export interface LinkObservation {
  sessionId: string;
  evidenceId: string;
  capturedAt: string;
  target: string;
  contextKey: string;
  status: number | null;
  complete: boolean;
  challenge: boolean;
  loginWall: boolean;
  soft404: boolean;
}

export interface LinkDetectorInput {
  linkKind: string;
  navigationApproved: boolean;
  target: string;
  observations: LinkObservation[];
  now: string;
  maxAgeMs?: number;
}

export type LinkDetectorResult =
  | {
      result: 'unknown';
      reason: string;
      evidence_ids: string[];
      proposed_grade: null;
      limitations: string[];
    }
  | {
      result: 'no_finding';
      reason: string;
      evidence_ids: string[];
      proposed_grade: null;
      limitations: string[];
    }
  | {
      result: 'candidate';
      reason: string;
      detector_id: string;
      detector_version: string;
      claim: string;
      evidence_ids: string[];
      proposed_grade: 'A';
      requires_human_review: true;
      limitations: string[];
    };

const unknown = (reason: string): LinkDetectorResult => ({
  result: 'unknown',
  reason,
  evidence_ids: [],
  proposed_grade: null,
  limitations: ['This rule does not measure revenue impact or whole-store health.'],
});

export function evaluateImportantLink(input: LinkDetectorInput): LinkDetectorResult {
  if (!input || input.linkKind !== 'important_information' || input.navigationApproved !== true) {
    return unknown('unsupported_or_unapproved_link');
  }
  if (!Array.isArray(input.observations) || input.observations.length < 2) {
    return unknown('insufficient_independent_captures');
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
        !Number.isFinite(Date.parse(o.capturedAt)),
    )
  ) {
    return unknown('invalid_capture_record');
  }
  if (
    new Set(obs.map((o) => o.sessionId)).size < 2 ||
    new Set(obs.map((o) => o.evidenceId)).size < 2
  ) {
    return unknown('insufficient_independent_captures');
  }
  if (
    obs.some(
      (o) =>
        o.complete !== true ||
        o.challenge !== false ||
        o.loginWall !== false ||
        o.soft404 !== false,
    )
  ) {
    return unknown('incomplete_or_ambiguous_capture');
  }
  if (
    obs.some(
      (o) => o.target !== input.target || typeof o.contextKey !== 'string' || !o.contextKey.trim(),
    ) ||
    new Set(obs.map((o) => o.contextKey)).size !== 1
  ) {
    return unknown('noncomparable_context');
  }
  const now = Date.parse(input.now);
  const freshMs = input.maxAgeMs ?? 86_400_000;
  if (!Number.isFinite(now) || !Number.isSafeInteger(freshMs) || freshMs < 1) {
    return unknown('invalid_freshness_policy');
  }
  if (obs.some((o) => Date.parse(o.capturedAt) > now || now - Date.parse(o.capturedAt) > freshMs)) {
    return unknown('stale_or_future_capture');
  }
  if (obs.every((o) => Number.isInteger(o.status) && o.status! >= 200 && o.status! < 300)) {
    return {
      result: 'no_finding',
      reason: 'link_loaded_in_recorded_checks',
      evidence_ids: obs.map((o) => o.evidenceId),
      proposed_grade: null,
      limitations: ['Only this link and its recorded conditions were tested.'],
    };
  }
  if (!obs.every((o) => o.status === 404 || o.status === 410)) {
    return unknown('inconsistent_or_unconfirmed_failure');
  }
  if (new Set(obs.map((o) => o.status)).size !== 1) return unknown('inconsistent_failure_status');
  return {
    result: 'candidate',
    reason: 'repeat_404_or_410',
    detector_id: DETECTOR_ID,
    detector_version: DETECTOR_VERSION,
    claim: `The linked information page returned HTTP ${obs[0]!.status} in ${obs.length} recorded checks.`,
    evidence_ids: obs.map((o) => o.evidenceId),
    proposed_grade: 'A',
    requires_human_review: true,
    limitations: [
      'Only the recorded link and conditions were tested.',
      'Store-wide scope and revenue impact are unknown.',
    ],
  };
}
