import { ERROR_CODES, problemType, type ErrorCode, type Problem } from '@oe/contracts';

/**
 * RFC 9457 problem responses.
 *
 * API_GUIDE.md: "Add request ID and retryable flag, never raw provider secrets or stack
 * traces. UI uses stable codes and clear messages." `detail` is always a sentence written
 * for a person; the machine-readable part is `code`.
 */
export class ApiProblem extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail: string,
    readonly extra: { statusOverride?: number } = {},
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ApiProblem';
  }

  get status(): number {
    return this.extra.statusOverride ?? ERROR_CODES[this.code].status;
  }

  toProblem(requestId: string): Problem {
    return {
      type: problemType(this.code),
      title: TITLES[this.code],
      status: this.status,
      code: this.code,
      detail: this.detail,
      request_id: requestId,
      retryable: ERROR_CODES[this.code].retryable,
    };
  }
}

const TITLES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'Authentication required',
  MEMBERSHIP_REQUIRED: 'No active membership',
  ROLE_REQUIRED: 'Role does not permit this action',
  VENTURE_NOT_ASSIGNED: 'Venture not assigned to this member',
  CSRF_INVALID: 'Missing or invalid CSRF token',
  ORIGIN_NOT_ALLOWED: 'Request origin not allowed',
  NOT_FOUND: 'Not found',
  VERSION_CONFLICT: 'The record changed since it was read',
  IDEMPOTENCY_CONFLICT: 'Idempotency key reused with different input',
  BUDGET_EXCEEDED: 'Cost ceiling would be exceeded',
  BUDGET_PAUSED: 'Budget is paused',
  INVALID_TRANSITION: 'State transition not allowed',
  STALE_REVIEW: 'Review is bound to an outdated version',
  DUPLICATE_REVIEW: 'This version has already been reviewed',
  INVALID_REQUEST: 'Request is invalid',
  TARGET_NOT_APPROVED: 'Target is not an approved host for this account',
  UNSAFE_TARGET: 'Target rejected by the capture safety policy',
  AUTHORIZATION_EXPIRED: 'Authorization has expired',
  AUTHORIZATION_REVOKED: 'Authorization was revoked',
  UNSUPPORTED_DETECTOR: 'Detector is not enabled in this phase',
  CURRENCY_MISMATCH: 'Currency does not match the tenant ledger',
  EVIDENCE_INCOMPLETE: 'Evidence does not support this action',
  RATE_LIMITED: 'Too many requests',
  PROVIDER_NOT_CONFIGURED: 'Provider is not configured',
  DEPENDENCY_UNAVAILABLE: 'A required dependency is unavailable',
};

export function problemResponse(problem: ApiProblem, requestId: string): Response {
  return new Response(JSON.stringify(problem.toProblem(requestId)), {
    status: problem.status,
    headers: { 'content-type': 'application/problem+json; charset=utf-8' },
  });
}
