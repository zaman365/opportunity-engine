/**
 * Stable machine-readable API error codes.
 *
 * The UI selects copy from these codes; never from a provider message or a stack trace.
 * `docs/architecture/API_GUIDE.md` fixes the HTTP status meanings.
 */
export const ERROR_CODES = {
  UNAUTHENTICATED: { status: 401, retryable: false },
  MEMBERSHIP_REQUIRED: { status: 403, retryable: false },
  ROLE_REQUIRED: { status: 403, retryable: false },
  VENTURE_NOT_ASSIGNED: { status: 403, retryable: false },
  CSRF_INVALID: { status: 403, retryable: false },
  ORIGIN_NOT_ALLOWED: { status: 403, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  VERSION_CONFLICT: { status: 409, retryable: false },
  IDEMPOTENCY_CONFLICT: { status: 409, retryable: false },
  BUDGET_EXCEEDED: { status: 409, retryable: false },
  BUDGET_PAUSED: { status: 409, retryable: false },
  INVALID_TRANSITION: { status: 409, retryable: false },
  STALE_REVIEW: { status: 409, retryable: false },
  DUPLICATE_REVIEW: { status: 409, retryable: false },
  INVALID_REQUEST: { status: 422, retryable: false },
  TARGET_NOT_APPROVED: { status: 422, retryable: false },
  UNSAFE_TARGET: { status: 422, retryable: false },
  AUTHORIZATION_EXPIRED: { status: 422, retryable: false },
  AUTHORIZATION_REVOKED: { status: 422, retryable: false },
  UNSUPPORTED_DETECTOR: { status: 422, retryable: false },
  CURRENCY_MISMATCH: { status: 422, retryable: false },
  EVIDENCE_INCOMPLETE: { status: 422, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  PROVIDER_NOT_CONFIGURED: { status: 503, retryable: false },
  DEPENDENCY_UNAVAILABLE: { status: 503, retryable: true },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const PROBLEM_TYPE_BASE = 'https://opportunity-engine.invalid/problems/';

/** Lower-case kebab problem type URI for a code, e.g. BUDGET_EXCEEDED → .../budget-exceeded. */
export function problemType(code: ErrorCode): string {
  return PROBLEM_TYPE_BASE + code.toLowerCase().replaceAll('_', '-');
}
