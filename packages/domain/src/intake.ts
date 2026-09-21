/**
 * Requested intake: the rules a stranger's submission has to pass.
 *
 * All pure. The API supplies the counts and the clock; nothing here reads a database or a
 * socket, so every refusal below is testable as arithmetic rather than as a scenario.
 *
 * The framing that matters, stated once: **a submission is a record that somebody asked.**
 * It is not permission. Verifying the contact address proves control of an inbox, not of a
 * website, and nothing in this file can produce authority to capture anything.
 */

import { preflightAddress, type PreflightDenial } from './url-policy.ts';

export type IntakeRefusal =
  | 'channel_unknown'
  | 'channel_disabled'
  | 'intake_disabled'
  | 'detector_not_offered'
  | 'rate_limited'
  | 'duplicate_request'
  | { target: PreflightDenial };

export type IntakeRequestState =
  'pending_verification' | 'verified' | 'declined' | 'expired' | 'converted';

/* ------------------------------------------------------------ rate limits */

/**
 * The windows an unauthenticated submission is counted against.
 *
 * Four keys, because each answers a different abuse. One address submitting repeatedly is a
 * nuisance; one source address submitting from a script is an attack; one target being
 * submitted by many people is someone trying to get a competitor scanned; and a channel
 * ceiling is the owner's own bound on what a day can cost them.
 *
 * All four are checked, and the strictest wins. A submission that passes three and fails one
 * is refused.
 */
export interface RateLimitRule {
  key: 'contact' | 'source' | 'target' | 'channel';
  windowSeconds: number;
  limit: number;
}

export const INTAKE_RATE_LIMITS: readonly RateLimitRule[] = [
  // One person asking about a few pages in an hour is normal; twenty is not.
  { key: 'contact', windowSeconds: 3600, limit: 3 },
  // A script from one address. Deliberately tighter than the per-address limit, because a
  // scripted attacker changes the address far more easily than the network path.
  { key: 'source', windowSeconds: 3600, limit: 10 },
  // Many people asking about one site in an hour reads as someone trying to get a site
  // scanned, not as demand.
  { key: 'target', windowSeconds: 3600, limit: 5 },
  // The owner's own daily ceiling, supplied per channel.
  { key: 'channel', windowSeconds: 86_400, limit: Number.NaN },
];

/** The fixed window a moment falls in. Same instant, same window, on every host. */
export function windowStart(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Which rule refused, so the caller can log a reason without logging the identifier. */
  exceeded: RateLimitRule['key'] | null;
  /** When the window the refusal came from ends. Told to the caller as a retry hint. */
  retryAfterSeconds: number;
}

/**
 * Decide from counts already taken.
 *
 * Every rule is counted before any is judged. Stopping at the first breach would make the
 * remaining counters depend on the order rules happen to be listed in, and an attacker who
 * reliably trips the first rule would never be counted against the others at all.
 */
export function judgeRateLimits(
  hits: { rule: RateLimitRule; hits: number }[],
  now: Date,
): RateLimitDecision {
  let exceeded: RateLimitRule['key'] | null = null;
  let retryAfterSeconds = 0;
  for (const { rule, hits: count } of hits) {
    if (!Number.isFinite(rule.limit) || count <= rule.limit) continue;
    const ends = windowStart(now, rule.windowSeconds).getTime() + rule.windowSeconds * 1000;
    const remaining = Math.max(1, Math.ceil((ends - now.getTime()) / 1000));
    if (remaining > retryAfterSeconds) {
      retryAfterSeconds = remaining;
      exceeded = rule.key;
    }
  }
  return { allowed: exceeded === null, exceeded, retryAfterSeconds };
}

/** The rules for one channel, with the owner's daily ceiling filled in. */
export function rateLimitsFor(dailyRequestLimit: number): RateLimitRule[] {
  return INTAKE_RATE_LIMITS.map((rule) =>
    rule.key === 'channel' ? { ...rule, limit: dailyRequestLimit } : { ...rule },
  );
}

/* ------------------------------------------------------------- validation */

export interface IntakeSubmission {
  targetUrl: string;
  requestedDetectors: string[];
}

export interface IntakeChannelState {
  enabled: boolean;
  allowedDetectors: string[];
}

export type IntakeCheck =
  { ok: true; targetUrl: string; targetHost: string } | { ok: false; refusal: IntakeRefusal };

/**
 * Whether a submission may be recorded at all.
 *
 * The target runs the same preflight as an operator-started scan — no relaxed public
 * variant. ADR-015 rejected a relaxed policy for fixtures for the same reason: a second,
 * looser copy of a safety rule eventually becomes the only one anybody reads.
 *
 * Note what is *not* checked: whether the target is an approved host. It cannot be, because
 * a requested check is precisely a request about a host nobody has approved yet. Approval is
 * an owner act that happens after this, and the scan path re-checks it.
 */
export function checkSubmission(
  submission: IntakeSubmission,
  channel: IntakeChannelState,
  intakeEnabled: boolean,
): IntakeCheck {
  if (!intakeEnabled) return { ok: false, refusal: 'intake_disabled' };
  if (!channel.enabled) return { ok: false, refusal: 'channel_disabled' };

  // The address rules, minus the account allowlist. A requested check is precisely a check
  // on a host nobody has approved yet; approving it is the owner act that comes later, and
  // the scan path re-checks it then.
  const preflight = preflightAddress(submission.targetUrl);
  if (!preflight.allowed) return { ok: false, refusal: { target: preflight.reason } };

  if (submission.requestedDetectors.length === 0) {
    return { ok: false, refusal: 'detector_not_offered' };
  }
  for (const detector of submission.requestedDetectors) {
    if (!channel.allowedDetectors.includes(detector)) {
      return { ok: false, refusal: 'detector_not_offered' };
    }
  }
  return { ok: true, targetUrl: preflight.url, targetHost: preflight.host };
}

/* ------------------------------------------------------- the request's life */

/**
 * How long a verification code is worth trying, and how often.
 *
 * Ten minutes and five attempts. A six-digit code has a million values, so five guesses in
 * ten minutes is a one-in-two-hundred-thousand chance — and the code is single use, so a
 * successful guess is worth one request record, not a standing capability.
 */
export const VERIFICATION_TTL_SECONDS = 600;
export const VERIFICATION_MAX_ATTEMPTS = 5;

/** How long a verified request stays actionable before it is stale. */
export const REQUEST_TTL_SECONDS = 30 * 86_400;

export type VerificationRefusal =
  | 'no_live_code'
  | 'code_expired'
  | 'too_many_attempts'
  | 'code_incorrect'
  | 'already_verified'
  | 'request_not_open';

export interface VerificationState {
  requestState: IntakeRequestState;
  expiresAt: string | null;
  consumedAt: string | null;
  attempts: number;
}

/**
 * Whether a code may even be compared, before comparing it.
 *
 * Deliberately separate from the comparison itself, so the expensive constant-time check
 * runs only on a live challenge, and so "expired" and "wrong" stay distinguishable in the
 * code while the caller decides what to tell the outside world.
 */
export function canAttemptVerification(
  state: VerificationState | null,
  now: Date,
): { ok: true } | { ok: false; refusal: VerificationRefusal } {
  if (state === null) return { ok: false, refusal: 'no_live_code' };
  if (state.requestState === 'verified' || state.requestState === 'converted') {
    return { ok: false, refusal: 'already_verified' };
  }
  if (state.requestState !== 'pending_verification') {
    return { ok: false, refusal: 'request_not_open' };
  }
  // Consumed means used, not merely seen. A code that already verified something must not
  // verify anything else, which is the whole of replay prevention.
  if (state.consumedAt !== null) return { ok: false, refusal: 'no_live_code' };
  if (state.expiresAt === null || Date.parse(state.expiresAt) <= now.getTime()) {
    return { ok: false, refusal: 'code_expired' };
  }
  if (state.attempts >= VERIFICATION_MAX_ATTEMPTS) {
    return { ok: false, refusal: 'too_many_attempts' };
  }
  return { ok: true };
}

/**
 * What the public may be told about a request.
 *
 * One shape for every outcome a stranger can reach. A caller holding a request id learns the
 * state and nothing else: not the address, not the operator's notes, not whether the target
 * is known to this workspace. `declined` and a request that never existed are deliberately
 * indistinguishable from outside — see `publicRequestState`.
 */
export function publicRequestState(state: IntakeRequestState): 'pending' | 'received' | 'closed' {
  switch (state) {
    case 'pending_verification':
      return 'pending';
    case 'verified':
    case 'converted':
      return 'received';
    // A decline is an internal judgement and can be about the requester. Reporting it as a
    // distinct state would leak that judgement to whoever holds the link.
    case 'declined':
    case 'expired':
      return 'closed';
  }
}
