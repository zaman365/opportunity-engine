/**
 * What a case is waiting on, derived from its findings.
 *
 * One rule in one place, because two places would eventually disagree. Both writers reach
 * for it: the runner, when a scan adds a finding to a case that already exists, and the
 * review service, when a reviewer decides one. Before the offer catalogue existed the
 * question never arose — every case sat at `review_evidence` forever — so the precedence
 * below is new and is stated here rather than implied by whichever code ran last.
 */

export type CaseNextAction =
  'review_evidence' | 'request_access' | 'revalidate' | 'draft_offer' | 'none';

export function nextActionForCase(input: {
  /** The state of every finding linked to the case. */
  findingStates: string[];
  current: string;
}): CaseNextAction {
  // A permission fact, not an evidence one. Nothing about findings can clear it, and
  // overwriting it with a workflow guess would hide that somebody has to ask for access.
  if (input.current === 'request_access') return 'request_access';

  // Anything undecided outranks everything else. A case is not ready to be quoted while part
  // of it is unreviewed — including a confirmed claim that went stale and needs looking at
  // again.
  if (input.findingStates.some((state) => state === 'candidate' || state === 'stale')) {
    return 'review_evidence';
  }
  // Only once nothing is outstanding does confirmed work become the next step.
  if (input.findingStates.includes('confirmed')) return 'draft_offer';
  // Everything was rejected or left unknown. Nothing was true this time, which is a reason to
  // look again later rather than to close the case.
  if (input.findingStates.length > 0) return 'revalidate';
  return 'none';
}
