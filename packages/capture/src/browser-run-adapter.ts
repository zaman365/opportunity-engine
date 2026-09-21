import type { CaptureOutcome, CaptureProvider, CaptureRequest } from './port.ts';
import { checkHop, resolveAndClassify } from './egress-guard.ts';

/**
 * Live public capture through Cloudflare Browser Run.
 *
 * ADR-005: live capture stays blocked until credentials, an approved processing policy and
 * a demonstrated deny-private-network egress boundary all exist. None of those have been
 * configured, so this adapter performs the checks it *can* perform and then reports
 * `not_configured`. It never falls back to the fixture transport and never fabricates a
 * result — SECURITY.md lists "hidden fallback from unavailable external provider to sample
 * success" as a release blocker.
 */
export class BrowserRunCaptureProvider implements CaptureProvider {
  readonly kind = 'browser_run' as const;
  readonly configured: boolean;
  readonly #endpoint: string | null;
  readonly #egressProofRecorded: boolean;

  constructor(options: { endpoint: string | null; egressProofRecorded: boolean }) {
    this.#endpoint = options.endpoint;
    this.#egressProofRecorded = options.egressProofRecorded;
    this.configured = Boolean(options.endpoint) && options.egressProofRecorded;
  }

  async capture(request: CaptureRequest): Promise<CaptureOutcome> {
    // Run the address policy first so an operator sees a target rejection rather than a
    // configuration message when the target itself is the problem.
    const hop = checkHop(request.url, request.approvedHosts, 0, request.limits.maxHops);
    if (!hop.allowed) {
      return {
        status: 'blocked',
        reason: hop.reason ?? 'hop_denied',
        detail: 'The target failed the approved-host and scheme policy.',
      };
    }
    const resolution = await resolveAndClassify(new URL(request.url).hostname);
    if (!resolution.allowed) {
      return {
        status: 'blocked',
        reason: resolution.reason ?? 'address_denied',
        detail: 'The target resolved to an address the egress policy denies.',
      };
    }

    if (!this.#endpoint) {
      return {
        status: 'not_configured',
        reason: 'browser_run_endpoint_missing',
        detail:
          'Live capture is not configured. No scan has been performed. Set BROWSER_RUN_ENDPOINT after owner authorization.',
      };
    }
    if (!this.#egressProofRecorded) {
      return {
        status: 'not_configured',
        reason: 'egress_boundary_unproven',
        detail:
          'Live capture stays disabled until the deny-private-network egress boundary is demonstrated and recorded (ADR-005).',
      };
    }
    // Deliberately unreachable in this build: `configured` is false, so the scan workflow
    // never selects this provider for execution. Implementing the call without the proven
    // boundary above would be the exact substitution ADR-005 forbids.
    return {
      status: 'not_configured',
      reason: 'adapter_not_implemented',
      detail:
        'The Browser Run client is not implemented in this milestone. M1 increment 5 covers it once the boundary tests pass.',
    };
  }
}
