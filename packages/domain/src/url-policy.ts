import { isIP } from 'node:net';

/**
 * Syntax and exact-host allowlist PREFLIGHT. This is not SSRF protection on its own.
 *
 * `networkValidationRequired` is always true on an allowed result: the capture adapter
 * must still resolve the destination address, reject non-public IPs, re-apply the policy
 * to every redirect hop and subrequest, and pin the connection against DNS rebinding.
 * See `packages/capture/src/egress-guard.ts` for that half.
 *
 * Ported from `reference/url-policy.mjs`; parity is asserted in tests.
 */

export type PreflightDenial =
  | 'invalid_url'
  | 'https_required'
  | 'embedded_credentials'
  | 'unsupported_port'
  | 'ip_literal_denied'
  | 'nonpublic_hostname'
  | 'invalid_hostname'
  | 'host_not_approved'
  | 'sensitive_query'
  | 'potential_state_change';

export type PreflightResult =
  | { allowed: false; reason: PreflightDenial }
  | { allowed: true; url: string; host: string; networkValidationRequired: true };

const SENSITIVE_QUERY_KEY =
  /^(token|access_token|auth|authorization|password|secret|api_key|key|session|code)$/i;

/** Paths that commonly mutate state even behind a GET. Never navigated by a scan. */
const STATE_CHANGE_PATH =
  /(?:^|[/_.-])(cart|checkout|logout|delete|remove|add-to-cart|action|account)(?:$|[/_.-])/i;

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function preflightTarget(
  raw: string,
  allowedHosts: readonly string[] = [],
): PreflightResult {
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
  if (url.protocol !== 'https:') return { allowed: false, reason: 'https_required' };
  if (url.username || url.password) return { allowed: false, reason: 'embedded_credentials' };
  if (url.port && url.port !== '443') return { allowed: false, reason: 'unsupported_port' };

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare) || host.includes(':')) return { allowed: false, reason: 'ip_literal_denied' };
  if (
    !host.includes('.') ||
    /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host)
  ) {
    return { allowed: false, reason: 'nonpublic_hostname' };
  }
  if (
    !/^[a-z0-9.-]+$/.test(host) ||
    host.split('.').some((s) => !s || s.length > 63 || s.startsWith('-') || s.endsWith('-'))
  ) {
    return { allowed: false, reason: 'invalid_hostname' };
  }
  const approved = Array.isArray(allowedHosts)
    ? allowedHosts.map((h) => String(h).toLowerCase().replace(/\.$/, ''))
    : [];
  if (!approved.includes(host)) return { allowed: false, reason: 'host_not_approved' };
  if ([...url.searchParams.keys()].some((k) => SENSITIVE_QUERY_KEY.test(k))) {
    return { allowed: false, reason: 'sensitive_query' };
  }
  if (STATE_CHANGE_PATH.test(decodeSafe(url.pathname))) {
    return { allowed: false, reason: 'potential_state_change' };
  }
  url.hostname = host;
  url.hash = '';
  return { allowed: true, url: url.href, host, networkValidationRequired: true };
}

/**
 * Conservative classifier for the one link MF-LINK-01 is allowed to follow.
 *
 * `SECURITY.md`: read-only is not simply GET. A link qualifies only when both its visible
 * text and its path look like informational size/fit/specification content, and nothing in
 * it looks like a state change. Everything else returns `unsupported` and the scan abstains.
 */
const INFORMATION_TEXT =
  /(size|sizing|fit|measurement|dimension|spec|specification|care|material|shipping|delivery|return|grössen|groessen|größen|masse|maße|pflege|versand|rückgabe|ruckgabe)/i;
const INFORMATION_PATH =
  /(size|sizing|fit|guide|measure|dimension|spec|care|material|shipping|delivery|return|groessen|grossen|pflege|versand|rueckgabe)/i;

export function classifyLink(
  text: string,
  href: string,
): { kind: 'important_information' | 'unsupported'; reason: string } {
  const label = typeof text === 'string' ? text.trim() : '';
  if (!label) return { kind: 'unsupported', reason: 'no_visible_link_text' };
  let path: string;
  try {
    path = decodeSafe(new URL(href, 'https://placeholder.invalid').pathname);
  } catch {
    return { kind: 'unsupported', reason: 'unparsable_href' };
  }
  if (STATE_CHANGE_PATH.test(path))
    return { kind: 'unsupported', reason: 'potential_state_change' };
  if (!INFORMATION_TEXT.test(label))
    return { kind: 'unsupported', reason: 'link_text_not_informational' };
  if (!INFORMATION_PATH.test(path))
    return { kind: 'unsupported', reason: 'link_path_not_informational' };
  return { kind: 'important_information', reason: 'informational_text_and_path' };
}
