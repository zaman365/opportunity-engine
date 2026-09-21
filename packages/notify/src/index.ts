/**
 * Getting a one-time code to a person.
 *
 * The port exists so the rest of the system can be written and tested; the adapter that
 * actually sends mail does not, and must not, until an owner approves it. M3: "Add token/OTP
 * delivery adapter only with owner approval."
 *
 * There is no fallback. `NotConfiguredChannel` refuses and says so rather than writing the
 * code into a log, a response body or a header where something else might read it — the same
 * shape as `BrowserRunCaptureProvider` reporting `not_configured` instead of quietly using
 * fixture data.
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export type DeliveryKind = 'recorded_local_only' | 'not_configured' | 'sent';

export interface DeliveryRequest {
  /** What the code is for. A channel that cannot serve this audience refuses. */
  audience: 'intake_verification';
  /** Opaque handle for the recipient. The channel resolves it; callers do not pass raw PII. */
  recipient: string;
  code: string;
  expiresAt: string;
}

export interface DeliveryOutcome {
  kind: DeliveryKind;
  /**
   * True only when the code reached, or could have reached, a person. False means nobody
   * received anything — which the caller must surface rather than reporting success.
   */
  delivered: boolean;
  /** Present only for `recorded_local_only`; never for a channel that could reach a stranger. */
  localCode?: string;
  detail: string;
}

export interface VerificationChannel {
  readonly kind: DeliveryKind;
  deliver(request: DeliveryRequest): Promise<DeliveryOutcome>;
}

/** The default everywhere. Sends nothing, claims nothing. */
export class NotConfiguredChannel implements VerificationChannel {
  readonly kind = 'not_configured' as const;

  deliver(): Promise<DeliveryOutcome> {
    return Promise.resolve({
      kind: 'not_configured',
      delivered: false,
      detail:
        'No verification channel is configured. Sending a code to a member of the public needs an owner-approved delivery adapter.',
    });
  }
}

/**
 * Local fixtures only: returns the code to the caller instead of sending it.
 *
 * Constructing this outside `APP_ENV=local` throws rather than degrading, because the failure
 * it would otherwise cause is silent — a deployment that looks like it is verifying addresses
 * while handing every code straight back to whoever asked.
 */
export class RecordedLocalChannel implements VerificationChannel {
  readonly kind = 'recorded_local_only' as const;

  constructor(environment: string) {
    if (environment !== 'local') {
      throw new Error(
        `RecordedLocalChannel refuses to run in ${environment}: it returns verification codes to the caller.`,
      );
    }
  }

  deliver(request: DeliveryRequest): Promise<DeliveryOutcome> {
    return Promise.resolve({
      kind: 'recorded_local_only',
      delivered: true,
      localCode: request.code,
      detail: 'Local fixture channel. The code was returned to the caller and sent to nobody.',
    });
  }
}

/* ------------------------------------------------------------------ codes */

/**
 * A six-digit code, uniformly distributed.
 *
 * `randomInt` rather than `Math.random`, and one draw over the whole range rather than six
 * draws of a digit, so every value including those with leading zeros is equally likely. Six
 * digits is a compromise a person can retype; what makes it safe is the attempt ceiling and
 * the ten-minute life, not the length.
 */
export function newVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Domain separator for keyed hashes.
 *
 * A byte that cannot occur in an audience name or an email address, so `hash(a, b)` and
 * `hash(a + b, '')` cannot collide. Written as a code point rather than as an escape in a
 * string literal so it stays visible to a reader of this file.
 */
const SEPARATOR = String.fromCharCode(0x1f);

/**
 * Keyed hash of a code, for storage.
 *
 * HMAC with a server-held secret, not a bare digest: six digits is a million values, so an
 * unkeyed hash of one is reversible by anybody who reads the table, in about a second. The
 * secret lives outside the database, so reading the database alone recovers nothing.
 *
 * The audience is mixed in, so a hash minted for one purpose cannot match a check for another
 * even when the digits coincide.
 */
export function hashCode(secret: string, audience: string, code: string): Buffer {
  return createHmac('sha256', secret).update(audience).update(SEPARATOR).update(code).digest();
}

/** Constant-time comparison. A length-varying compare leaks the code a digit at a time. */
export function codeMatches(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * An opaque, stable key for a value that must never appear in a counter table or a log.
 *
 * Used for rate-limit keys. Those counters sit outside the tenant boundary, so whatever they
 * are keyed by has to be meaningless to anyone who reads them. Keyed rather than hashed, for
 * the same reason as above: an email address has far less entropy than it looks.
 */
export function opaqueKey(secret: string, namespace: string, value: string): string {
  return createHmac('sha256', secret)
    .update(namespace)
    .update(SEPARATOR)
    .update(value.trim().toLowerCase())
    .digest('hex');
}
