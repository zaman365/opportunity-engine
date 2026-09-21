import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Engagement,
  EngagementDetail,
  Finding,
  OfferDraft,
  OfferMatch,
  Opportunity,
  PaymentRecord,
  Scan,
} from '@oe/contracts';
import {
  createApiHarness,
  LOCAL_FIXTURE,
  scanRequest,
  stopFixtureSite,
  type ApiHarness,
} from '../support/api-harness.ts';

/**
 * From an accepted scope to work that is tracked, disputed or closed.
 *
 * WORKFLOWS.md sets three rules and each one has its own refusal below: nothing starts before
 * acceptance, acceptance is a recorded act rather than a payment event, and a scope change is
 * a new quote rather than an amendment.
 */

let h: ApiHarness;
let opportunityId: string;
let draftId: string;
let engagementId: string;

beforeAll(async () => {
  h = await createApiHarness();

  const admitted = await h.json<Scan>(
    await h.request('/api/v1/scans', { method: 'POST', body: JSON.stringify(scanRequest()) }),
  );
  await h.drain();
  const scan = await h.json<Scan>(await h.request(`/api/v1/scans/${admitted.id}`));

  const review = await h.request(`/api/v1/findings/${scan.finding_ids[0]}/review`, {
    method: 'POST',
    subject: 'reviewer@fixture.test',
    body: JSON.stringify({
      expected_version: 1,
      decision: 'confirm',
      reason: 'Both recorded checks returned 404 for the linked size guide.',
      acknowledged_limitations: true,
    }),
  });
  expect(review.status, await review.clone().text()).toBe(200);
  await h.json<Finding>(review);

  const cases = await h.json<{ items: Opportunity[] }>(await h.request('/api/v1/opportunities'));
  opportunityId = cases.items[0]!.id;

  for (const prerequisite of [
    'authorized code/platform access',
    'agreed destination',
    'scope approval',
  ]) {
    const recorded = await h.request(
      `/api/v1/accounts/${LOCAL_FIXTURE.accountA}/offer-prerequisites`,
      {
        method: 'POST',
        subject: 'owner@fixture.test',
        body: JSON.stringify({
          prerequisite,
          note: `Synthetic fixture: ${prerequisite} confirmed in writing.`,
        }),
      },
    );
    expect(recorded.status, await recorded.clone().text()).toBe(201);
  }

  const match = await h.json<OfferMatch>(
    await h.request(`/api/v1/opportunities/${opportunityId}/offers`),
  );
  const created = await h.request(`/api/v1/opportunities/${opportunityId}/offer-drafts`, {
    method: 'POST',
    subject: 'reviewer@fixture.test',
    body: JSON.stringify({ offer_id: match.eligible[0]!.offer.id }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  draftId = (await h.json<OfferDraft>(created)).id;
}, 180_000);

afterAll(async () => {
  await h?.stop();
  stopFixtureSite();
});

function advance(
  id: string,
  body: Record<string, unknown>,
  subject = 'reviewer@fixture.test',
): Promise<Response> {
  return h.request(`/api/v1/engagements/${id}/advance`, {
    method: 'POST',
    subject,
    body: JSON.stringify(body),
  });
}

async function current(id: string): Promise<Engagement> {
  return (await h.json<EngagementDetail>(await h.request(`/api/v1/engagements/${id}`))).engagement;
}

describe('opening work against a scope', () => {
  it('refuses an operator', async () => {
    const response = await h.request('/api/v1/engagements', {
      method: 'POST',
      subject: 'operator@fixture.test',
      body: JSON.stringify({ opportunity_id: opportunityId, offer_draft_id: draftId }),
    });
    expect(response.status).toBe(403);
  });

  it('opens in draft, bound to the scope and not carrying a copy of it', async () => {
    const response = await h.request('/api/v1/engagements', {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({ opportunity_id: opportunityId, offer_draft_id: draftId }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const engagement = await h.json<Engagement>(response);
    engagementId = engagement.id;

    expect(engagement.state).toBe('draft');
    expect(engagement.offer_draft_id).toBe(draftId);
    expect(engagement.accepted_at).toBeNull();
    // No scope and no price on the engagement: the draft holds the snapshot, and two copies
    // of a number is two chances for them to disagree.
    const keys = Object.keys(engagement);
    for (const forbidden of ['price', 'price_minor', 'snapshot', 'inclusions']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('refuses a second live engagement against the same scope', async () => {
    const response = await h.request('/api/v1/engagements', {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({ opportunity_id: opportunityId, offer_draft_id: draftId }),
    });
    expect(response.status).toBe(409);
  });

  it('records how it was opened, in its own history', async () => {
    const detail = await h.json<EngagementDetail>(
      await h.request(`/api/v1/engagements/${engagementId}`),
    );
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]!.reason).toContain('MF-LINK-REPAIR');
    expect(detail.payments).toEqual([]);
  });
});

describe('nothing starts before acceptance', () => {
  it('refuses to jump straight to work', async () => {
    // Not a legal edge in the first place, so it is refused as a shape error rather than as
    // a missing acceptance — which is the more informative of the two answers.
    const response = await advance(engagementId, {
      expected_version: 1,
      next_state: 'in_progress',
      reason: 'Skipping ahead.',
    });
    expect(response.status).toBe(409);
    expect((await h.json<{ code: string }>(response)).code).toBe('INVALID_TRANSITION');
  });

  it('refuses to leave the pre-acceptance states with no note', async () => {
    expect(
      (
        await advance(engagementId, {
          expected_version: 1,
          next_state: 'awaiting_acceptance',
          reason: 'Quote sent.',
        })
      ).status,
    ).toBe(200);

    const response = await advance(engagementId, {
      expected_version: 2,
      next_state: 'ready',
      reason: 'They said yes on the phone.',
    });
    expect(response.status).toBe(422);
    const problem = await h.json<{ detail: string }>(response);
    // The sentence says the thing that is easiest to get wrong.
    expect(problem.detail).toContain('A payment is not an acceptance');
  });

  it('refuses a note too short to say anything', async () => {
    const response = await advance(engagementId, {
      expected_version: 2,
      next_state: 'ready',
      reason: 'Accepted.',
      acceptance_note: 'yes',
    });
    expect(response.status).toBe(422);
  });

  it('records acceptance as a time, a note and a named member', async () => {
    const response = await advance(engagementId, {
      expected_version: 2,
      next_state: 'ready',
      reason: 'Scope accepted.',
      acceptance_note:
        'Accepted by email from the shop owner on 22 September 2026, quoting the scope.',
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const engagement = await h.json<Engagement>(response);

    expect(engagement.state).toBe('ready');
    expect(engagement.accepted_at).not.toBeNull();
    expect(engagement.accepted_by).not.toBeNull();
    expect(engagement.acceptance_note).toContain('by email');
  });

  it('refuses an acceptance note on a transition that does not record one', async () => {
    // Refused rather than ignored: silently dropping it would let somebody believe they had
    // recorded an acceptance that is not there.
    const response = await advance(engagementId, {
      expected_version: 3,
      next_state: 'in_progress',
      reason: 'Starting.',
      acceptance_note: 'They accepted again, apparently.',
    });
    expect(response.status).toBe(422);
    expect((await h.json<{ detail: string }>(response)).detail).toContain('Remove the note');
  });
});

describe('the work itself', () => {
  it('moves through verification to accepted, recording every step', async () => {
    const steps: [string, string][] = [
      ['in_progress', 'Repair started against the agreed destination.'],
      ['awaiting_verification', 'Change deployed; running the acceptance tests.'],
      ['accepted', 'Destination loads in the recorded conditions; customer accepted.'],
    ];
    for (const [next, reason] of steps) {
      const engagement = await current(engagementId);
      const response = await advance(engagementId, {
        expected_version: engagement.version,
        next_state: next,
        reason,
      });
      expect(response.status, `${next}: ${await response.clone().text()}`).toBe(200);
      expect((await h.json<Engagement>(response)).state).toBe(next);
    }

    const detail = await h.json<EngagementDetail>(
      await h.request(`/api/v1/engagements/${engagementId}`),
    );
    // Every transition, with its reason, in order, and each tied to the version it produced.
    expect(detail.events.map((e) => e.to_state)).toEqual([
      'draft',
      'awaiting_acceptance',
      'ready',
      'in_progress',
      'awaiting_verification',
      'accepted',
    ]);
    for (const event of detail.events) expect(event.reason.length).toBeGreaterThan(0);
    expect(detail.events.map((e) => e.to_version)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('refuses a move at a version that already changed', async () => {
    const response = await advance(engagementId, {
      expected_version: 1,
      next_state: 'closed',
      reason: 'Stale attempt.',
    });
    expect(response.status).toBe(409);
    expect((await h.json<{ code: string }>(response)).code).toBe('VERSION_CONFLICT');
  });
});

describe('money', () => {
  it('is an owner record, not a reviewer one', async () => {
    const response = await h.request(`/api/v1/engagements/${engagementId}/payments`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        kind: 'invoice_issued',
        currency: 'EUR',
        amount_minor: '29000',
        external_ref: 'INV-2026-0001',
        note: 'Issued after acceptance.',
        occurred_at: '2026-09-22T09:00:00Z',
      }),
    });
    expect(response.status).toBe(403);
  });

  it('records an invoice and a payment without moving the engagement', async () => {
    const before = await current(engagementId);
    for (const kind of ['invoice_issued', 'payment_received'] as const) {
      const response = await h.request(`/api/v1/engagements/${engagementId}/payments`, {
        method: 'POST',
        subject: 'owner@fixture.test',
        body: JSON.stringify({
          kind,
          currency: 'EUR',
          amount_minor: '29000',
          external_ref: kind === 'invoice_issued' ? 'INV-2026-0001' : 'BANK-77213',
          note: `Recorded by hand: ${kind.replaceAll('_', ' ')}.`,
          occurred_at: '2026-09-22T09:00:00Z',
        }),
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const record = await h.json<PaymentRecord>(response);
      expect(record.amount).toEqual({
        currency: 'EUR',
        amount_minor: '29000',
        tax_treatment: null,
      });
      // No card data anywhere in the shape, because none is accepted anywhere.
      const serialised = JSON.stringify(record);
      for (const forbidden of ['card', 'pan', 'cvv', 'iban', 'processor', 'token']) {
        expect(serialised.toLowerCase(), forbidden).not.toContain(forbidden);
      }
    }

    // A payment is evidence money arrived, not evidence work was accepted.
    const after = await current(engagementId);
    expect(after.state).toBe(before.state);
    expect(after.version).toBe(before.version);
  });
});

describe('a changed scope is a new quote', () => {
  it('sends a change request back to draft rather than amending an accepted scope', async () => {
    // An accepted engagement is still live. The scope is occupied until it is closed, which
    // is what stops two commitments to do one job existing side by side.
    const accepted = await current(engagementId);
    expect(accepted.state).toBe('accepted');
    const blocked = await h.request('/api/v1/engagements', {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({ opportunity_id: opportunityId, offer_draft_id: draftId }),
    });
    expect(blocked.status).toBe(409);

    const closed = await advance(engagementId, {
      expected_version: accepted.version,
      next_state: 'closed',
      reason: 'Work delivered and accepted; nothing outstanding.',
    });
    expect(closed.status, await closed.clone().text()).toBe(200);

    const fresh = await h.json<Engagement>(
      await h.request('/api/v1/engagements', {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({ opportunity_id: opportunityId, offer_draft_id: draftId }),
      }),
    );
    expect(fresh.state).toBe('draft');

    const quoted = await advance(fresh.id, {
      expected_version: 1,
      next_state: 'awaiting_acceptance',
      reason: 'Quote sent.',
    });
    expect(quoted.status).toBe(200);

    const changed = await advance(fresh.id, {
      expected_version: 2,
      next_state: 'change_requested',
      reason: 'The customer wants a different destination page.',
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const engagement = await h.json<Engagement>(changed);
    // A side state names its reason and its owner. Both enforced as constraints too.
    expect(engagement.side_reason).toContain('different destination');
    expect(engagement.side_owner).not.toBeNull();

    const back = await advance(fresh.id, {
      expected_version: 3,
      next_state: 'draft',
      reason: 'Re-quoting against a new scope.',
    });
    expect(back.status).toBe(200);
    // Still unaccepted, because the thing they were going to accept has changed.
    expect((await h.json<Engagement>(back)).accepted_at).toBeNull();
  });
});

describe('tenant isolation', () => {
  it('hides an engagement from another workspace entirely', async () => {
    const response = await h.request(`/api/v1/engagements/${engagementId}`, {
      subject: 'other-owner@fixture.test',
    });
    expect(response.status).toBe(404);
  });
});
