import { describe, expect, it } from 'vitest';
import {
  canAttemptVerification,
  canonicalDetectorId,
  checkSubmission,
  isImplementedDetector,
  matchOffers,
  sameDetector,
  judgeRateLimits,
  publicRequestState,
  rateLimitsFor,
  windowStart,
  VERIFICATION_MAX_ATTEMPTS,
} from '@oe/domain';
import {
  codeMatches,
  hashCode,
  newVerificationCode,
  NotConfiguredChannel,
  opaqueKey,
  RecordedLocalChannel,
} from '@oe/notify';

/**
 * The rules behind the only unauthenticated surface in this application.
 *
 * All pure, so every abuse case below is arithmetic rather than a scenario: no database, no
 * clock, no network. What that buys is the ability to state the ceiling exactly — five
 * guesses, three requests an hour — instead of approximately.
 */

const CHANNEL = { enabled: true, allowedDetectors: ['MF-LINK-01', 'MF-ASSET-01'] };

describe('checkSubmission', () => {
  const good = {
    targetUrl: 'https://shop.example.com/products/jacket',
    requestedDetectors: ['MF-LINK-01'],
  };

  it('accepts a public https target on an offered check', () => {
    const result = checkSubmission(good, CHANNEL, true);
    expect(result).toMatchObject({ ok: true, targetHost: 'shop.example.com' });
  });

  it('accepts a host nobody has approved, because that is what a request is', () => {
    // The operator path requires the target to be on an account's allowlist. A requested
    // check is precisely about a host that is not on one yet; approving it is the owner act
    // that comes afterwards, and the scan path re-checks it then.
    const result = checkSubmission(
      { ...good, targetUrl: 'https://never-seen-before.example.org/p' },
      CHANNEL,
      true,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses everything the operator path refuses about an address', () => {
    // A public form that accepted what the internal path refuses would be the way around
    // every address rule in the system.
    const cases: [string, string][] = [
      ['http://shop.example.com/p', 'https_required'],
      ['https://user:pw@shop.example.com/p', 'embedded_credentials'],
      ['https://shop.example.com:8443/p', 'unsupported_port'],
      ['https://127.0.0.1/p', 'ip_literal_denied'],
      ['https://169.254.169.254/latest/', 'ip_literal_denied'],
      ['https://shop.localhost/p', 'nonpublic_hostname'],
      ['https://shop.internal/p', 'nonpublic_hostname'],
      ['file:///etc/passwd', 'https_required'],
      ['https://shop.example.com/p?token=abc', 'sensitive_query'],
      ['https://shop.example.com/cart', 'potential_state_change'],
    ];
    for (const [url, reason] of cases) {
      const result = checkSubmission({ ...good, targetUrl: url }, CHANNEL, true);
      expect(result, url).toMatchObject({ ok: false, refusal: { target: reason } });
    }
  });

  it('refuses a check the channel does not offer', () => {
    expect(
      checkSubmission({ ...good, requestedDetectors: ['PDP-VISUAL-01'] }, CHANNEL, true),
    ).toMatchObject({ ok: false, refusal: 'detector_not_offered' });
    // One offered and one not is still not offered: no partial acceptance.
    expect(
      checkSubmission(
        { ...good, requestedDetectors: ['MF-LINK-01', 'PDP-VISUAL-01'] },
        CHANNEL,
        true,
      ),
    ).toMatchObject({ ok: false, refusal: 'detector_not_offered' });
  });

  it('refuses when the feature or the channel is off', () => {
    expect(checkSubmission(good, CHANNEL, false)).toMatchObject({
      ok: false,
      refusal: 'intake_disabled',
    });
    expect(checkSubmission(good, { ...CHANNEL, enabled: false }, true)).toMatchObject({
      ok: false,
      refusal: 'channel_disabled',
    });
  });
});

describe('rate limit windows', () => {
  it('puts the same instant in the same window everywhere', () => {
    const at = new Date('2026-09-21T14:37:42.500Z');
    expect(windowStart(at, 3600).toISOString()).toBe('2026-09-21T14:00:00.000Z');
    expect(windowStart(at, 86_400).toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });

  it('judges every rule, not the first that fails', () => {
    // Stopping early would make the remaining counters depend on list order, and an attacker
    // who reliably trips the first rule would never be counted against the others.
    const rules = rateLimitsFor(25);
    const now = new Date('2026-09-21T14:30:00Z');
    const decision = judgeRateLimits(
      rules.map((rule) => ({ rule, hits: rule.limit + 1 })),
      now,
    );
    expect(decision.allowed).toBe(false);
    // The longest window wins the retry hint: telling somebody to come back in a minute when
    // the daily ceiling is what stopped them would be a lie.
    expect(decision.exceeded).toBe('channel');
    expect(decision.retryAfterSeconds).toBe(9 * 3600 + 30 * 60);
  });

  it('allows a submission exactly at the limit and refuses the one after', () => {
    const rule = rateLimitsFor(25).find((r) => r.key === 'contact')!;
    const now = new Date('2026-09-21T14:30:00Z');
    expect(judgeRateLimits([{ rule, hits: rule.limit }], now).allowed).toBe(true);
    expect(judgeRateLimits([{ rule, hits: rule.limit + 1 }], now).allowed).toBe(false);
  });

  it('treats a channel with no stated ceiling as unbounded, not as zero', () => {
    // `rateLimitsFor` fills the owner's number in. A NaN limit would otherwise compare false
    // against everything and refuse every request, which is the wrong failure.
    const rules = rateLimitsFor(0);
    const channel = rules.find((r) => r.key === 'channel')!;
    expect(channel.limit).toBe(0);
    expect(judgeRateLimits([{ rule: channel, hits: 1 }], new Date()).allowed).toBe(false);
  });
});

describe('canAttemptVerification', () => {
  const live = {
    requestState: 'pending_verification' as const,
    expiresAt: '2026-09-21T14:10:00Z',
    consumedAt: null,
    attempts: 0,
  };
  const now = new Date('2026-09-21T14:05:00Z');

  it('allows a live, unspent, unexpired code', () => {
    expect(canAttemptVerification(live, now)).toEqual({ ok: true });
  });

  it('refuses a code that has already been spent', () => {
    // Replay. The single-use column is what prevents it, not the caller's good manners.
    expect(canAttemptVerification({ ...live, consumedAt: '2026-09-21T14:01:00Z' }, now)).toEqual({
      ok: false,
      refusal: 'no_live_code',
    });
  });

  it('refuses after the code expires, to the second', () => {
    const at = new Date('2026-09-21T14:10:00Z');
    expect(canAttemptVerification(live, at)).toEqual({ ok: false, refusal: 'code_expired' });
  });

  it('refuses the sixth guess', () => {
    expect(
      canAttemptVerification({ ...live, attempts: VERIFICATION_MAX_ATTEMPTS - 1 }, now).ok,
    ).toBe(true);
    expect(canAttemptVerification({ ...live, attempts: VERIFICATION_MAX_ATTEMPTS }, now)).toEqual({
      ok: false,
      refusal: 'too_many_attempts',
    });
  });

  it('refuses to re-verify what is already verified', () => {
    expect(canAttemptVerification({ ...live, requestState: 'verified' }, now)).toEqual({
      ok: false,
      refusal: 'already_verified',
    });
    expect(canAttemptVerification({ ...live, requestState: 'declined' }, now)).toEqual({
      ok: false,
      refusal: 'request_not_open',
    });
  });

  it('refuses when there is no challenge at all', () => {
    expect(canAttemptVerification(null, now)).toEqual({ ok: false, refusal: 'no_live_code' });
  });
});

describe('publicRequestState', () => {
  it('tells a stranger three things, not five', () => {
    expect(publicRequestState('pending_verification')).toBe('pending');
    expect(publicRequestState('verified')).toBe('received');
    expect(publicRequestState('converted')).toBe('received');
    // A decline is an internal judgement that may be about the requester. Reporting it as its
    // own state would hand that judgement to whoever holds the link.
    expect(publicRequestState('declined')).toBe('closed');
    expect(publicRequestState('expired')).toBe('closed');
  });
});

describe('codes', () => {
  it('draws six digits including the ones with leading zeros', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const code = newVerificationCode();
      expect(code).toMatch(/^\d{6}$/);
      seen.add(code);
    }
    // 2000 draws from a million values: collisions are expected, a tiny range is not.
    expect(seen.size).toBeGreaterThan(1900);
  });

  it('will not match a hash minted for a different audience', () => {
    const secret = 'unit-test-secret';
    expect(
      codeMatches(
        hashCode(secret, 'intake_verification', '123456'),
        hashCode(secret, 'intake_verification', '123456'),
      ),
    ).toBe(true);
    expect(
      codeMatches(
        hashCode(secret, 'intake_verification', '123456'),
        hashCode(secret, 'report_access', '123456'),
      ),
    ).toBe(false);
    expect(
      codeMatches(
        hashCode(secret, 'intake_verification', '123456'),
        hashCode('other', 'intake_verification', '123456'),
      ),
    ).toBe(false);
  });

  it('keys an opaque value stably, and differently per namespace', () => {
    const secret = 'unit-test-secret';
    const a = opaqueKey(secret, 'intake_contact', 'Person@Example.com ');
    // Same address, differently typed, is the same person for counting purposes.
    expect(a).toBe(opaqueKey(secret, 'intake_contact', 'person@example.com'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // The same address counted for two different things must not share a window.
    expect(a).not.toBe(opaqueKey(secret, 'intake_source', 'person@example.com'));
  });
});

describe('verification channels', () => {
  it('refuses rather than pretending, when none is configured', async () => {
    const outcome = await new NotConfiguredChannel().deliver();
    expect(outcome.delivered).toBe(false);
    expect(outcome.localCode).toBeUndefined();
    expect(outcome.detail).toContain('owner-approved');
  });

  it('will not construct the code-returning channel outside local', () => {
    // The failure it would otherwise cause is silent: a deployment that looks like it is
    // verifying addresses while handing every code back to whoever asked.
    expect(() => new RecordedLocalChannel('production')).toThrow(/refuses to run in production/);
    expect(() => new RecordedLocalChannel('staging')).toThrow();
    expect(() => new RecordedLocalChannel('local')).not.toThrow();
  });

  it('returns the code locally and says it sent nothing', async () => {
    const outcome = await new RecordedLocalChannel('local').deliver({
      audience: 'intake_verification',
      recipient: 'opaque',
      code: '424242',
      expiresAt: '2026-09-21T14:10:00Z',
    });
    expect(outcome).toMatchObject({ delivered: true, localCode: '424242' });
    expect(outcome.detail).toContain('sent to nobody');
  });
});

/**
 * The detector namespace, and what happens to the old spellings.
 *
 * The rename is only safe because nothing compares raw strings any more. These are the cases
 * that would break silently if something did — a catalogue entry, a public form, or a finding
 * written in one namespace meeting a comparison written in the other.
 */
describe('detector namespace', () => {
  it('maps every venture-scoped spelling onto a Consistency Engine rule', () => {
    expect(canonicalDetectorId('MF-LINK-01')).toBe('CE-LINK-01');
    expect(canonicalDetectorId('MF-ASSET-01')).toBe('CE-ASSET-01');
    expect(canonicalDetectorId('MF-DATA-01')).toBe('CE-DATA-01');
    expect(canonicalDetectorId('PDP-CONTENT-01')).toBe('CE-CONTENT-01');
    expect(canonicalDetectorId('PDP-VISUAL-01')).toBe('CE-VISUAL-01');
    expect(canonicalDetectorId('PDP-MOBILE-01')).toBe('CE-MOBILE-01');
    // Canonical in, canonical out.
    expect(canonicalDetectorId('CE-LINK-01')).toBe('CE-LINK-01');
    // And an id naming no rule stays unknown rather than being guessed at.
    expect(canonicalDetectorId('XX-NOPE-01')).toBeNull();
  });

  it('treats the two spellings as one rule', () => {
    expect(sameDetector('MF-LINK-01', 'CE-LINK-01')).toBe(true);
    expect(sameDetector('CE-ASSET-01', 'MF-ASSET-01')).toBe(true);
    expect(sameDetector('MF-LINK-01', 'MF-ASSET-01')).toBe(false);
    expect(sameDetector('XX-NOPE-01', 'XX-NOPE-01')).toBe(false);
  });

  it('accepts either spelling for a rule this build runs, and neither for one it does not', () => {
    for (const id of ['CE-LINK-01', 'CE-ASSET-01', 'MF-LINK-01', 'MF-ASSET-01']) {
      expect(isImplementedDetector(id), id).toBe(true);
    }
    // Specified in contracts/detectors.json, not built, so not requestable under any name.
    for (const id of ['CE-DATA-01', 'MF-DATA-01', 'CE-VISUAL-01', 'PDP-VISUAL-01']) {
      expect(isImplementedDetector(id), id).toBe(false);
    }
  });

  it('matches a catalogue entry written in the old namespace', () => {
    // The kit's offer catalogue says `MF-LINK-01` and stays byte-identical. A finding produced
    // today says `CE-LINK-01`. A scope that stopped matching because a namespace moved would
    // route real work to manual quotation for no reason.
    const result = matchOffers({
      confirmedFindings: [{ id: 'f1', detectorId: 'CE-LINK-01', rootCauseKey: 'size-guide-404' }],
      catalog: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          sku: 'MF-LINK-REPAIR',
          version: 1,
          promise: 'Repair one supported information-link root cause.',
          detectorFamilies: ['MF-LINK-01'],
          inclusions: [],
          exclusions: [],
          prerequisites: [],
          acceptance: ['destination loads'],
          currency: 'EUR',
          priceMinor: '29000',
          taxTreatment: 'net',
          minEffortMinutes: 60,
          maxEffortMinutes: 180,
          enabled: true,
        },
      ],
      satisfiedPrerequisites: [],
      openCommitments: 0,
      deliveryCapacity: 3,
    });
    expect(result.eligible).toHaveLength(1);
  });

  it('offers a check a form listed under the old namespace', () => {
    const result = checkSubmission(
      {
        targetUrl: 'https://shop.example.com/p',
        requestedDetectors: ['CE-LINK-01'],
      },
      { enabled: true, allowedDetectors: ['MF-LINK-01'] },
      true,
    );
    expect(result.ok).toBe(true);
  });
});
