import { describe, expect, it } from 'vitest';
import { checkHop, classifyAddress, resolveAndClassify } from '@oe/capture';
import { classifyLink } from '@oe/domain';

/**
 * SECURITY.md, "Minimum protections before live capture". These tests cover the policy
 * decisions; ADR-005 still requires a demonstrated socket-level boundary before live
 * capture is switched on, which is why `BrowserRunCaptureProvider` stays unconfigured.
 */

describe('address classification', () => {
  const denied: [string, string][] = [
    ['127.0.0.1', 'loopback_address'],
    ['0.0.0.0', 'unspecified_address'],
    ['10.1.2.3', 'private_address'],
    ['172.16.0.1', 'private_address'],
    ['172.31.255.255', 'private_address'],
    ['192.168.1.1', 'private_address'],
    ['169.254.169.254', 'metadata_address'],
    ['169.254.1.1', 'link_local_address'],
    ['100.64.0.1', 'private_address'],
    ['198.18.0.1', 'reserved_address'],
    ['224.0.0.1', 'multicast_address'],
    ['255.255.255.255', 'reserved_address'],
    ['::1', 'loopback_address'],
    ['fe80::1', 'link_local_address'],
    ['fd00::1', 'private_address'],
    ['::ffff:169.254.169.254', 'mapped_ipv4_address'],
    ['64:ff9b::1.2.3.4', 'mapped_ipv4_address'],
  ];

  it.each(denied)('denies %s as %s', (address, reason) => {
    const verdict = classifyAddress(address);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe(reason);
  });

  it.each([['93.184.216.34'], ['2606:2800:220:1:248:1893:25c8:1946']])(
    'allows public %s',
    (address) => {
      expect(classifyAddress(address).allowed).toBe(true);
    },
  );

  it('allows 172.32.0.1, which is outside the private range', () => {
    expect(classifyAddress('172.32.0.1').allowed).toBe(true);
  });

  it('denies a host whose answers mix public and private addresses', async () => {
    const verdict = await resolveAndClassify('rebinding.example', async () => [
      { address: '93.184.216.34' },
      { address: '127.0.0.1' },
    ]);
    expect(verdict.allowed).toBe(false);
    expect(verdict.deniedAddress).toBe('127.0.0.1');
  });

  it('denies a host that does not resolve', async () => {
    const verdict = await resolveAndClassify('nowhere.example', async () => {
      throw new Error('NXDOMAIN');
    });
    expect(verdict).toEqual({ allowed: false, reason: 'unresolvable_host', addresses: [] });
  });
});

describe('redirect and subrequest hops', () => {
  const approved = ['shop.example.com'];

  it('applies the approved-host policy to every hop, not just the first', () => {
    expect(checkHop('https://shop.example.com/a', approved, 0).allowed).toBe(true);
    expect(checkHop('https://evil.example.net/a', approved, 1)).toMatchObject({
      allowed: false,
      reason: 'host_not_approved',
    });
  });

  it('stops following redirects past the hop ceiling', () => {
    expect(checkHop('https://shop.example.com/a', approved, 4, 3)).toMatchObject({
      allowed: false,
      reason: 'too_many_hops',
    });
  });

  it('rejects non-http schemes and credentials in a redirect target', () => {
    expect(checkHop('file:///etc/passwd', approved, 1).reason).toBe('scheme_not_allowed');
    expect(checkHop('https://u:p@shop.example.com/', approved, 1).reason).toBe(
      'credentials_in_url',
    );
  });

  it('rejects an unexpected port', () => {
    expect(checkHop('https://shop.example.com:8443/', approved, 1).reason).toBe('port_not_allowed');
  });
});

describe('link classification', () => {
  it('accepts an informational size-guide link', () => {
    expect(
      classifyLink('Find your fit — size guide', 'https://shop.example.com/size-guide').kind,
    ).toBe('important_information');
  });

  it('refuses links whose path could change store state', () => {
    for (const href of [
      'https://shop.example.com/cart/add',
      'https://shop.example.com/account/logout',
      'https://shop.example.com/size-guide/delete',
    ]) {
      expect(classifyLink('Size guide', href).kind).toBe('unsupported');
    }
  });

  it('refuses a link whose text is not informational even when the path looks right', () => {
    expect(classifyLink('Buy now', 'https://shop.example.com/size-guide').kind).toBe('unsupported');
  });

  it('refuses a link with no visible text, since a reviewer could not judge it', () => {
    expect(classifyLink('   ', 'https://shop.example.com/size-guide').reason).toBe(
      'no_visible_link_text',
    );
  });

  it('accepts German informational wording', () => {
    expect(classifyLink('Größentabelle ansehen', 'https://shop.example.com/groessen').kind).toBe(
      'important_information',
    );
  });
});
