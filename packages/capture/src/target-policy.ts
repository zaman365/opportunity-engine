import { preflightTarget, type PreflightResult } from '@oe/domain';

/**
 * Which target policy a build uses.
 *
 * TEST_PLAN.md: "A local test-only transport may connect to [the fixture site]; never weaken
 * production URL policy to make a fixture work. Correctly separate network access policy
 * from detector logic."
 *
 * So there are two policies, not one relaxed policy. `preflightTarget` — https only, public
 * hostnames only, no IP literals — is untouched and is what every deployed build uses.
 * The fixture policy below is a separate function that admits exactly one loopback origin
 * and is only constructible when the local fixture adapter is configured, which
 * `loadConfig` refuses outside APP_ENV=local.
 */

export type TargetPolicy = (url: string, approvedHosts: readonly string[]) => PreflightResult;

/** The production policy. Also used by the live adapter before any address resolution. */
export const productionTargetPolicy: TargetPolicy = (url, approvedHosts) =>
  preflightTarget(url, approvedHosts);

const STATE_CHANGE_PATH =
  /(?:^|[/_.-])(cart|checkout|logout|delete|remove|add-to-cart|action|account)(?:$|[/_.-])/i;
const SENSITIVE_QUERY_KEY =
  /^(token|access_token|auth|authorization|password|secret|api_key|key|session|code)$/i;

/**
 * Test-only policy for the kit's loopback fixture site.
 *
 * Everything except the scheme/host rule is identical to production: the account's approved
 * host list still applies, state-changing paths are still refused, and token-like query
 * parameters are still rejected. An operator therefore cannot point a local scan at an
 * arbitrary loopback service.
 */
export function createFixtureTargetPolicy(
  fixtureOrigins: string | readonly string[],
): TargetPolicy {
  const list = typeof fixtureOrigins === 'string' ? [fixtureOrigins] : [...fixtureOrigins];
  if (list.length === 0) throw new Error('At least one fixture origin is required.');
  const origins = list.map((value) => {
    const origin = new URL(value);
    const host = origin.hostname;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
      throw new Error('The fixture target policy only accepts a loopback origin.');
    }
    return origin;
  });

  return (raw, approvedHosts) => {
    // Control characters and raw spaces are rejected outright: they are how a URL gets
    // split or smuggled past a parser, so matching them is the point of this expression.
    // eslint-disable-next-line no-control-regex
    if (typeof raw !== 'string' || raw.length > 4096 || /[\u0000-\u0020\u007f]/.test(raw)) {
      return { allowed: false, reason: 'invalid_url' };
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { allowed: false, reason: 'invalid_url' };
    }
    const origin = origins.find((candidate) => candidate.origin === url.origin);
    if (!origin) return { allowed: false, reason: 'host_not_approved' };
    if (url.username || url.password) return { allowed: false, reason: 'embedded_credentials' };

    // The account allowlist still gates the target, using host:port for the fixture site.
    const authority = origin.host.toLowerCase();
    const approved = approvedHosts.map((h) => String(h).toLowerCase().replace(/\.$/, ''));
    if (!approved.includes(authority)) return { allowed: false, reason: 'host_not_approved' };

    if ([...url.searchParams.keys()].some((k) => SENSITIVE_QUERY_KEY.test(k))) {
      return { allowed: false, reason: 'sensitive_query' };
    }
    if (STATE_CHANGE_PATH.test(decodeSafe(url.pathname))) {
      return { allowed: false, reason: 'potential_state_change' };
    }
    url.hash = '';
    return { allowed: true, url: url.href, host: authority, networkValidationRequired: true };
  };
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
