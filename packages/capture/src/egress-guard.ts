import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * Destination-address policy: the half of SSRF protection that `preflightTarget` cannot do.
 *
 * SECURITY.md: "Resolve all IPs and block non-public/loopback/link-local/private/metadata
 * destinations, IPv4-mapped IPv6 and rebinding; recheck at connection time. Apply policy to
 * redirects and every browser subrequest, not just the top-level page."
 *
 * This module answers "is this address allowed" and "is this hop allowed". It does not by
 * itself pin the socket to the resolved address; the live adapter must do that at connect
 * time, which is why live capture stays blocked until that boundary is demonstrated
 * (ADR-005).
 */

export type EgressDenial =
  | 'unresolvable_host'
  | 'private_address'
  | 'loopback_address'
  | 'link_local_address'
  | 'metadata_address'
  | 'unspecified_address'
  | 'multicast_address'
  | 'reserved_address'
  | 'mapped_ipv4_address'
  | 'unsupported_address_family';

export interface AddressVerdict {
  allowed: boolean;
  reason?: EgressDenial;
  address: string;
}

function ipv4Verdict(address: string): AddressVerdict {
  const parts = address.split('.').map(Number);
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  if (a === 0) return { allowed: false, reason: 'unspecified_address', address };
  if (a === 127) return { allowed: false, reason: 'loopback_address', address };
  if (a === 10) return { allowed: false, reason: 'private_address', address };
  if (a === 172 && b >= 16 && b <= 31) return { allowed: false, reason: 'private_address', address };
  if (a === 192 && b === 168) return { allowed: false, reason: 'private_address', address };
  // Cloud instance metadata, and the wider link-local block it sits in.
  if (a === 169 && b === 254) {
    return { allowed: false, reason: c === 169 && d === 254 ? 'metadata_address' : 'link_local_address', address };
  }
  if (a === 100 && b >= 64 && b <= 127) return { allowed: false, reason: 'private_address', address };
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return { allowed: false, reason: 'reserved_address', address };
  if (a === 198 && (b === 18 || b === 19)) return { allowed: false, reason: 'reserved_address', address };
  if (a === 198 && b === 51 && c === 100) return { allowed: false, reason: 'reserved_address', address };
  if (a === 203 && b === 0 && c === 113) return { allowed: false, reason: 'reserved_address', address };
  if (a >= 224 && a <= 239) return { allowed: false, reason: 'multicast_address', address };
  if (a >= 240) return { allowed: false, reason: 'reserved_address', address };
  return { allowed: true, address };
}

function ipv6Verdict(address: string): AddressVerdict {
  const lower = address.toLowerCase();
  if (lower === '::' ) return { allowed: false, reason: 'unspecified_address', address };
  if (lower === '::1') return { allowed: false, reason: 'loopback_address', address };
  // ::ffff:a.b.c.d and ::ffff:0:a.b.c.d smuggle an IPv4 destination past a naive check.
  const mapped = /^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return { allowed: false, reason: 'mapped_ipv4_address', address };
  if (/^fe[89ab]/.test(lower)) return { allowed: false, reason: 'link_local_address', address };
  if (/^f[cd]/.test(lower)) return { allowed: false, reason: 'private_address', address };
  if (/^ff/.test(lower)) return { allowed: false, reason: 'multicast_address', address };
  if (lower.startsWith('64:ff9b:')) return { allowed: false, reason: 'mapped_ipv4_address', address };
  if (lower.startsWith('100:')) return { allowed: false, reason: 'reserved_address', address };
  if (lower.startsWith('2001:db8')) return { allowed: false, reason: 'reserved_address', address };
  return { allowed: true, address };
}

/** Classify a literal address. Pure, so the policy itself is unit-testable without DNS. */
export function classifyAddress(address: string): AddressVerdict {
  if (isIPv4(address)) return ipv4Verdict(address);
  if (isIPv6(address)) return ipv6Verdict(address);
  return { allowed: false, reason: 'unsupported_address_family', address };
}

export interface ResolutionVerdict {
  allowed: boolean;
  reason?: EgressDenial;
  addresses: string[];
  deniedAddress?: string;
}

/**
 * Resolve a hostname and require *every* answer to be public.
 *
 * A host that resolves to one public and one private address is denied: a resolver that
 * rotates answers would otherwise let a second lookup reach the private one.
 */
export async function resolveAndClassify(
  hostname: string,
  resolver: (host: string) => Promise<{ address: string }[]> = (host) => lookup(host, { all: true }),
): Promise<ResolutionVerdict> {
  let answers: { address: string }[];
  try {
    answers = await resolver(hostname);
  } catch {
    return { allowed: false, reason: 'unresolvable_host', addresses: [] };
  }
  if (!answers.length) return { allowed: false, reason: 'unresolvable_host', addresses: [] };
  const addresses = answers.map((a) => a.address);
  for (const address of addresses) {
    const verdict = classifyAddress(address);
    if (!verdict.allowed) {
      return {
        allowed: false,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        addresses,
        deniedAddress: address,
      };
    }
  }
  return { allowed: true, addresses };
}

export type HopDenial =
  | 'scheme_not_allowed'
  | 'port_not_allowed'
  | 'host_not_approved'
  | 'too_many_hops'
  | 'credentials_in_url';

/**
 * Policy for a redirect hop or a page subrequest. Applied to every navigation and every
 * resource the page asks for, not only the URL the operator typed.
 */
export function checkHop(
  rawUrl: string,
  approvedHosts: readonly string[],
  hopIndex: number,
  maxHops = 3,
): { allowed: boolean; reason?: HopDenial; host?: string } {
  if (hopIndex > maxHops) return { allowed: false, reason: 'too_many_hops' };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'scheme_not_allowed' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { allowed: false, reason: 'scheme_not_allowed' };
  }
  if (url.username || url.password) return { allowed: false, reason: 'credentials_in_url' };
  if (url.port && url.port !== '443' && url.port !== '80') {
    return { allowed: false, reason: 'port_not_allowed' };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const approved = approvedHosts.map((h) => h.toLowerCase().replace(/\.$/, ''));
  if (!approved.includes(host)) return { allowed: false, reason: 'host_not_approved', host };
  return { allowed: true, host };
}
