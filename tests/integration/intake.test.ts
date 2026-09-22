import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Budget,
  IntakeChannel,
  IntakeForm,
  IntakeRequest,
  PublicIntakeRequest,
} from '@oe/contracts';
import {
  createApiHarness,
  LOCAL_FIXTURE,
  stopFixtureSite,
  type ApiHarness,
} from '../support/api-harness.ts';

/**
 * The only unauthenticated surface in this application, exercised against the real API.
 *
 * M3's gate names the cases: "Verification abuse/replay; consent not implied; cross-tenant
 * request/report; expired/revoked share; attacker-controlled redirect; request budget
 * exhaustion; missing integration produces unavailable." Each one below is a refusal, because
 * on a public surface the refusals are the feature.
 */

let h: ApiHarness;

const CHANNEL_A = 'intake-a.fixture.test';
const CHANNEL_B = 'intake-b.fixture.test';

beforeAll(async () => {
  h = await createApiHarness();
}, 180_000);

afterAll(async () => {
  await h?.stop();
  stopFixtureSite();
});

/**
 * A request as it would arrive from a venture's own site.
 *
 * The host header is the whole of the tenant decision, so it is the only thing these helpers
 * vary. There is no tenant field to pass even if a caller wanted to.
 */
async function publicRequest(
  path: string,
  init: { host?: string; body?: unknown; origin?: string | null; source?: string } = {},
): Promise<Response> {
  const { host = CHANNEL_A, body, origin, source } = init;
  const headers = new Headers({ host, 'x-forwarded-host': host });
  if (origin !== null) headers.set('origin', origin ?? `https://${host}`);
  if (source) headers.set('x-forwarded-for', source);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return await h.app.fetch(
    new Request(`http://127.0.0.1:4173${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

let uniqueSuffix = 0;
/** A fresh contact and source each time, so one test's rate-limit counts do not fail another. */
function submission(overrides: Record<string, unknown> = {}) {
  uniqueSuffix += 1;
  return {
    target_url: `https://shop${uniqueSuffix}.example.com/product`,
    requested_detectors: ['MF-LINK-01'],
    purpose: 'The size guide link on our product page looks broken to customers.',
    authority_claim: 'I am the owner of this shop and I am asking for this check myself.',
    contact_email: `requester${uniqueSuffix}@example.com`,
    ...overrides,
  };
}

function uniqueSource(): string {
  uniqueSuffix += 1;
  return `198.51.100.${uniqueSuffix % 250}`;
}

describe('the form a requester is shown', () => {
  it('discloses the scope before it will take anything', async () => {
    const response = await publicRequest('/public/intake/form');
    expect(response.status).toBe(200);
    const form = await h.json<IntakeForm>(response);
    expect(form.host).toBe(CHANNEL_A);
    expect(form.allowed_detectors).toEqual(['CE-LINK-01', 'CE-ASSET-01']);
    // The purpose text has to say what happens to the address and that a person reviews the
    // result. The length floor in the schema is a proxy for that; this asserts the substance.
    expect(form.purpose_text).toMatch(/person reviews every result/i);
    expect(form.purpose_text).toMatch(/does not sign you up/i);
  });

  it('is not there at all on a host nobody registered', async () => {
    const response = await publicRequest('/public/intake/form', { host: 'unknown.example.com' });
    // 404, not 403: an unregistered host and a disabled one must look the same from outside.
    expect(response.status).toBe(404);
  });
});

describe('submitting a request', () => {
  it('records it, and returns the code only because the local channel sends nothing', async () => {
    const response = await publicRequest('/public/intake', {
      body: submission(),
      source: uniqueSource(),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const created = await h.json<PublicIntakeRequest>(response);
    expect(created.state).toBe('pending');
    expect(created.local_verification_code).toMatch(/^\d{6}$/);
    expect(created.delivery_detail).toContain('sent to nobody');
    // Nothing about the workspace reaches the requester.
    expect(Object.keys(created)).not.toContain('venture_id');
    expect(Object.keys(created)).not.toContain('contact_email');
  });

  it('refuses a target the capture policy would refuse', async () => {
    // The same preflight as an operator-started scan. A public form that accepted what the
    // internal path refuses would be the way around every address rule in the system.
    for (const target of [
      'http://127.0.0.1/admin',
      'https://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/internal',
      'file:///etc/passwd',
      'https://user:pass@shop.example.com/p',
    ]) {
      const response = await publicRequest('/public/intake', {
        body: submission({ target_url: target }),
        source: uniqueSource(),
      });
      expect(response.status, target).toBe(422);
      expect((await h.json<{ code: string }>(response)).code, target).toBe('UNSAFE_TARGET');
    }
  });

  it('refuses a check this channel does not offer', async () => {
    const response = await publicRequest('/public/intake', {
      body: submission({ requested_detectors: ['PDP-VISUAL-01'] }),
      source: uniqueSource(),
    });
    expect(response.status).toBe(422);
    expect((await h.json<{ code: string }>(response)).code).toBe('UNSUPPORTED_DETECTOR');
  });

  it('refuses a submission posted from somewhere other than the venture site', async () => {
    const response = await publicRequest('/public/intake', {
      body: submission(),
      origin: 'https://attacker.example.com',
      source: uniqueSource(),
    });
    expect(response.status).toBe(403);
  });

  it('does not let the body choose a workspace', async () => {
    // There is no tenant field in the contract; sending one must be refused rather than
    // ignored, so a future schema change cannot quietly start honouring it.
    const response = await publicRequest('/public/intake', {
      body: { ...submission(), tenant_id: LOCAL_FIXTURE.tenantB },
      source: uniqueSource(),
    });
    expect(response.status).toBe(422);
  });

  it('spends no budget: a request is not a scan', async () => {
    const before = await budgets();
    await publicRequest('/public/intake', { body: submission(), source: uniqueSource() });
    expect(await budgets()).toEqual(before);
  });

  async function budgets(): Promise<{ reserved: string; settled: string }[]> {
    const response = await h.json<{ items: Budget[] }>(
      await h.request('/api/v1/budgets', { subject: 'owner@fixture.test' }),
    );
    return response.items.map((b) => ({ reserved: b.reserved_micro, settled: b.settled_micro }));
  }
});

describe('verification', () => {
  async function open(): Promise<PublicIntakeRequest> {
    const response = await publicRequest('/public/intake', {
      body: submission(),
      source: uniqueSource(),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return h.json<PublicIntakeRequest>(response);
  }

  it('moves the request to received when the code is right', async () => {
    const created = await open();
    const response = await publicRequest(`/public/intake/${created.id}/verify`, {
      body: { code: created.local_verification_code },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await h.json<PublicIntakeRequest>(response)).state).toBe('received');
  });

  it('refuses the same code twice', async () => {
    // Replay. The code is spent by the first use; a second finds nothing left to spend.
    const created = await open();
    const body = { code: created.local_verification_code };
    expect((await publicRequest(`/public/intake/${created.id}/verify`, { body })).status).toBe(200);
    const replay = await publicRequest(`/public/intake/${created.id}/verify`, { body });
    expect(replay.status).toBe(422);
  });

  it('refuses a code minted for another request', async () => {
    const mine = await open();
    const theirs = await open();
    const response = await publicRequest(`/public/intake/${mine.id}/verify`, {
      body: { code: theirs.local_verification_code },
    });
    // Two codes that happen to collide would pass this; one in a million, and it would still
    // only verify a request the caller already held the id for.
    if (mine.local_verification_code !== theirs.local_verification_code) {
      expect(response.status).toBe(422);
    }
  });

  it('gives up after five wrong guesses, even with the right code afterwards', async () => {
    const created = await open();
    const wrong = created.local_verification_code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await publicRequest(`/public/intake/${created.id}/verify`, {
        body: { code: wrong },
      });
      expect(response.status, `attempt ${attempt}`).toBe(422);
    }
    const correct = await publicRequest(`/public/intake/${created.id}/verify`, {
      body: { code: created.local_verification_code },
    });
    expect(correct.status).toBe(422);
    expect(
      (await h.json<PublicIntakeRequest>(await publicRequest(`/public/intake/${created.id}`)))
        .state,
    ).toBe('pending');
  });

  it('says the same thing however it refuses', async () => {
    // Expired, wrong, already used and never existed are all things an attacker would like
    // to tell apart. From outside they are one message.
    const created = await open();
    const wrong = created.local_verification_code === '000000' ? '111111' : '000000';
    const bad = await publicRequest(`/public/intake/${created.id}/verify`, {
      body: { code: wrong },
    });
    const missing = await publicRequest(`/public/intake/${LOCAL_FIXTURE.accountA}/verify`, {
      body: { code: wrong },
    });
    const badDetail = (await h.json<{ detail: string }>(bad)).detail;
    // A request that does not exist is a 404 by path, not a different verification answer;
    // what matters is that a *live* request never explains which part of the code was wrong.
    expect(badDetail).toBe('That code is not valid. Request a new one.');
    expect(missing.status).toBe(404);
  });

  it('refuses a code presented through a different venture site', async () => {
    const created = await open();
    const response = await publicRequest(`/public/intake/${created.id}/verify`, {
      host: CHANNEL_B,
      body: { code: created.local_verification_code },
    });
    // Channel B is a different workspace entirely; its tenant has no such request.
    expect(response.status).toBe(404);
  });
});

describe('rate limits', () => {
  it('stops one address after the third request in an hour', async () => {
    uniqueSuffix += 1;
    const contact = `flooder${uniqueSuffix}@example.com`;
    const accepted: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await publicRequest('/public/intake', {
        body: submission({ contact_email: contact }),
        source: uniqueSource(),
      });
      accepted.push(response.status);
    }
    expect(accepted.slice(0, 3)).toEqual([201, 201, 201]);
    expect(accepted.slice(3)).toEqual([429, 429]);
  });

  it('counts a refused submission too', async () => {
    // A limiter that counts only successes is one an attacker can run flat out for free.
    uniqueSuffix += 1;
    const contact = `refused${uniqueSuffix}@example.com`;
    for (let i = 0; i < 3; i += 1) {
      const response = await publicRequest('/public/intake', {
        body: submission({ contact_email: contact, target_url: 'http://127.0.0.1/admin' }),
        source: uniqueSource(),
      });
      expect(response.status).toBe(422);
    }
    const good = await publicRequest('/public/intake', {
      body: submission({ contact_email: contact }),
      source: uniqueSource(),
    });
    expect(good.status).toBe(429);
  });

  it('stops one source address whatever contact it uses', async () => {
    const source = `203.0.113.${(uniqueSuffix += 1) % 250}`;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await publicRequest('/public/intake', {
        body: submission(),
        source,
      });
      statuses.push(response.status);
    }
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(10);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('what the requester can read back', () => {
  it('returns a coarse state and nothing else', async () => {
    const created = await h.json<PublicIntakeRequest>(
      await publicRequest('/public/intake', { body: submission(), source: uniqueSource() }),
    );
    const response = await publicRequest(`/public/intake/${created.id}`);
    expect(response.status).toBe(200);
    const read = await h.json<PublicIntakeRequest>(response);
    expect(read.state).toBe('pending');
    // The code is returned once, at submission, and never again.
    expect(read.local_verification_code).toBeNull();
  });

  it('will not confirm a request belonging to another venture site', async () => {
    const created = await h.json<PublicIntakeRequest>(
      await publicRequest('/public/intake', { body: submission(), source: uniqueSource() }),
    );
    const response = await publicRequest(`/public/intake/${created.id}`, { host: CHANNEL_B });
    expect(response.status).toBe(404);
  });
});

describe('the operator queue', () => {
  let requestId: string;

  beforeAll(async () => {
    const created = await h.json<PublicIntakeRequest>(
      await publicRequest('/public/intake', { body: submission(), source: uniqueSource() }),
    );
    await publicRequest(`/public/intake/${created.id}/verify`, {
      body: { code: created.local_verification_code },
    });
    requestId = created.id;
  });

  it('never records marketing consent from a request for a check', async () => {
    // M3: "Separate requested report delivery from marketing consent." The column is not
    // written by the submission path at all, so there is no argument to be had about defaults.
    const request = await h.json<IntakeRequest>(
      await h.request(`/api/v1/intake-requests/${requestId}`, { subject: 'reviewer@fixture.test' }),
    );
    expect(request.marketing_consent).toBe(false);
    expect(request.state).toBe('verified');
    expect(request.verified_at).not.toBeNull();
  });

  it('shows a viewer the queue without the requester address', async () => {
    const list = await h.json<{ items: IntakeRequest[] }>(
      await h.request('/api/v1/intake-requests?state=verified', {
        subject: 'viewer@fixture.test',
      }),
    );
    expect(list.items.length).toBeGreaterThan(0);
    for (const item of list.items) expect(item.contact_email).toBeNull();
  });

  it('shows a reviewer the address, because answering needs it', async () => {
    const request = await h.json<IntakeRequest>(
      await h.request(`/api/v1/intake-requests/${requestId}`, { subject: 'reviewer@fixture.test' }),
    );
    expect(request.contact_email).toMatch(/@example\.com$/);
    // The authority claim is recorded as a claim. It is not permission, and no account or
    // authorization has appeared from it.
    expect(request.authority_claim).toContain('I am the owner');
    expect(request.account_id).toBeNull();
  });

  it('hides another workspace request entirely', async () => {
    const response = await h.request(`/api/v1/intake-requests/${requestId}`, {
      subject: 'other-owner@fixture.test',
    });
    expect(response.status).toBe(404);
  });

  it('declines with a reason, and tells the requester only that it is closed', async () => {
    const current = await h.json<IntakeRequest>(
      await h.request(`/api/v1/intake-requests/${requestId}`, { subject: 'reviewer@fixture.test' }),
    );
    const response = await h.request(`/api/v1/intake-requests/${requestId}/decline`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        expected_version: current.version,
        reason: 'We cannot establish that the requester controls this site.',
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await h.json<IntakeRequest>(response)).state).toBe('declined');

    const publicView = await h.json<PublicIntakeRequest>(
      await publicRequest(`/public/intake/${requestId}`),
    );
    // "closed", not "declined": the reason is an internal judgement that may be about the
    // requester, and it is not theirs to read.
    expect(publicView.state).toBe('closed');
    expect(Object.keys(publicView)).not.toContain('decision_reason');
  });

  it('refuses a decline at a version that already moved', async () => {
    const response = await h.request(`/api/v1/intake-requests/${requestId}/decline`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({ expected_version: 1, reason: 'Second attempt.' }),
    });
    expect(response.status).toBe(409);
  });

  it('refuses a decline from an operator', async () => {
    const response = await h.request(`/api/v1/intake-requests/${requestId}/decline`, {
      method: 'POST',
      subject: 'operator@fixture.test',
      body: JSON.stringify({ expected_version: 2, reason: 'Not my call.' }),
    });
    expect(response.status).toBe(403);
  });
});

describe('closing the form', () => {
  it('is an owner act, and makes the public surface disappear', async () => {
    const channels = await h.json<{ items: IntakeChannel[] }>(
      await h.request('/api/v1/intake-channels', { subject: 'owner@fixture.test' }),
    );
    const channel = channels.items.find((item) => item.host === CHANNEL_A)!;
    expect(channel.enabled).toBe(true);

    const asReviewer = await h.request(`/api/v1/intake-channels/${channel.id}/enabled`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({ enabled: false }),
    });
    expect(asReviewer.status).toBe(403);

    const closed = await h.request(`/api/v1/intake-channels/${channel.id}/enabled`, {
      method: 'POST',
      subject: 'owner@fixture.test',
      body: JSON.stringify({ enabled: false }),
    });
    expect(closed.status, await closed.clone().text()).toBe(200);

    // Closed reads exactly like never registered.
    expect((await publicRequest('/public/intake/form')).status).toBe(404);
    expect(
      (await publicRequest('/public/intake', { body: submission(), source: uniqueSource() }))
        .status,
    ).toBe(404);

    // Put it back, so a later run of this file starts where this one did.
    await h.request(`/api/v1/intake-channels/${channel.id}/enabled`, {
      method: 'POST',
      subject: 'owner@fixture.test',
      body: JSON.stringify({ enabled: true }),
    });
  });
});

/**
 * The embedded form, and the one cross-origin allowance it needs.
 *
 * The widget runs on a venture's own site and talks to this API, so those requests are
 * genuinely cross-origin. What matters is that the allowance is exactly as wide as the set of
 * hosts an owner registered, and no wider.
 */
describe('the embed', () => {
  it('serves a script that derives its origin rather than accepting one', async () => {
    const response = await publicRequest('/public/intake/embed.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    const script = await response.text();

    // The origin comes from the script's own URL. An embedding page that could configure it
    // could point the form at another workspace.
    expect(script).toContain('new URL(self.src, location.href).origin');
    // Everything written into the page is text, never markup.
    expect(script).toContain('node.textContent = value');
    // Assigned usage, not the word: the script's own comment says "textContent, never
    // innerHTML", and a test that matched the word would fail on the explanation.
    expect(script).not.toMatch(/\.innerHTML\s*=/);
    expect(script).not.toMatch(/insertAdjacentHTML/);
    // No cookie or Access session can ride along, even if one existed.
    expect(script).toContain("credentials: 'omit'");
    // And there is no marketing checkbox to pre-tick, ticked or otherwise.
    expect(script.toLowerCase()).not.toContain('marketing');
  });

  it('grants a cross-origin allowance to a registered site and nobody else', async () => {
    const allowed = await publicRequest('/public/intake/form');
    expect(allowed.headers.get('access-control-allow-origin')).toBe(`https://${CHANNEL_A}`);
    expect(allowed.headers.get('vary')).toContain('Origin');

    // An unregistered origin gets no allowance, so a browser stops the request before it is
    // made — which is the right place for it to stop.
    const stranger = await h.app.fetch(
      new Request('http://127.0.0.1:4173/public/intake/form', {
        headers: {
          host: CHANNEL_A,
          'x-forwarded-host': CHANNEL_A,
          origin: 'https://attacker.example.com',
        },
      }),
    );
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a preflight for a registered site, and refuses one for a stranger', async () => {
    const preflight = await h.app.fetch(
      new Request('http://127.0.0.1:4173/public/intake', {
        method: 'OPTIONS',
        headers: {
          host: CHANNEL_A,
          'x-forwarded-host': CHANNEL_A,
          origin: `https://${CHANNEL_A}`,
          'access-control-request-method': 'POST',
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(`https://${CHANNEL_A}`);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');

    const stranger = await h.app.fetch(
      new Request('http://127.0.0.1:4173/public/intake', {
        method: 'OPTIONS',
        headers: {
          host: CHANNEL_A,
          'x-forwarded-host': CHANNEL_A,
          origin: 'https://attacker.example.com',
          'access-control-request-method': 'POST',
        },
      }),
    );
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull();
  });
});

/**
 * The form in the language of the site it sits on.
 *
 * Channel A is registered in English, channel B in German. The labels come from the API, in
 * the channel's language — a form whose labels a host page could rewrite is a form whose
 * privacy sentence a host page could rewrite.
 */
describe('the form speaks the site language', () => {
  it('serves English labels for an English channel', async () => {
    const form = await h.json<IntakeForm>(await publicRequest('/public/intake/form'));
    expect(form.language).toBe('en');
    expect((form.copy as Record<string, string>)['heading']).toBe('Request a check');
    expect((form.copy as Record<string, string>)['privacy']).toContain('does not sign you up');
  });

  it('serves German labels for a German channel', async () => {
    const form = await h.json<IntakeForm>(
      await publicRequest('/public/intake/form', { host: CHANNEL_B }),
    );
    expect(form.language).toBe('de');
    const copy = form.copy as Record<string, string>;
    expect(copy['heading']).toBe('Prüfung anfragen');
    // The sentence that matters most on this form, in the language of the person reading it.
    expect(copy['privacy']).toContain('keine Anmeldung');
    expect(copy['privacy']).not.toMatch(/\bthe\b/);
  });

  it('keeps the labels out of the script, so a host cannot ship its own', async () => {
    const script = await (await publicRequest('/public/intake/embed.js')).text();
    // The one string the script owns is the failure it cannot fetch anything to describe.
    expect(script).toContain('This form is not available right now.');
    expect(script).not.toContain('does not sign you up');
    expect(script).not.toContain('Request a check');
    expect(script).toContain('form.copy');
  });
});
