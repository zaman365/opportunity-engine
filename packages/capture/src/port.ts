/**
 * CaptureProvider port.
 *
 * INTEGRATIONS.md: every provider returns `configured`, `blocked`, `retryable_error`,
 * `permanent_error` or a result with provenance — "never fabricated success". There is no
 * path in this interface that produces a page observation without a real response.
 */

export interface CaptureRequest {
  /** Already preflighted and approved by `preflightTarget`. */
  url: string;
  approvedHosts: readonly string[];
  /** One dedicated browser session per account per clean check. */
  sessionId: string;
  sessionOrdinal: number;
  /** Ties two observations to the same page/variant context so they are comparable. */
  contextKey: string;
  role: 'source_page' | 'link_destination';
  viewport: { width: number; height: number };
  locale: string;
  operationKey: string;
  /** Hard ceilings; the adapter aborts rather than widening them. */
  limits: { timeoutMs: number; maxBytes: number; maxHops: number };
}

export interface CaptureConditionsResult {
  captured_at: string;
  session_id: string;
  viewport_width: number;
  viewport_height: number;
  locale: string;
  variant: string | null;
  consent_state: string;
  browser_version: string;
  test_region: string | null;
}

export interface PageObservation {
  /** HTTP status of the final response, or null when no response was received. */
  status: number | null;
  finalUrl: string;
  redirectChain: string[];
  /** True only when the whole bounded capture completed within its limits. */
  complete: boolean;
  /** Set when the response is an access challenge rather than a real page answer. */
  challenge: boolean;
  loginWall: boolean;
  /** A 200 that renders a "not found" page. Ambiguity, not a confirmed defect. */
  soft404: boolean;
  bodyBytes: number;
  contentType: string | null;
  /** Links the page exposes, already filtered to safe candidates by the adapter. */
  links: { text: string; href: string }[];
  /** Raw page bytes, kept only when policy allows persisting the artifact. */
  body: Uint8Array | null;
  screenshot: { body: Uint8Array; contentType: string } | null;
  /** Why a screenshot is missing, when it is. Never silently absent. */
  screenshotUnavailableReason: string | null;
}

export type CaptureOutcome =
  | { status: 'captured'; observation: PageObservation; conditions: CaptureConditionsResult; providerRequestId: string; costMicro: string }
  | { status: 'blocked'; reason: string; detail: string }
  | { status: 'not_configured'; reason: string; detail: string }
  | { status: 'retryable_error'; reason: string; detail: string }
  | { status: 'permanent_error'; reason: string; detail: string };

export interface CaptureProvider {
  readonly kind: 'local_fixture' | 'browser_run';
  /** Reported in readiness without contacting the provider or spending money. */
  readonly configured: boolean;
  capture(request: CaptureRequest): Promise<CaptureOutcome>;
}
