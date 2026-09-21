import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Finding,
  Offer,
  OfferDraft,
  OfferMatch,
  OfferPrerequisite,
  Opportunity,
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
 * From a confirmed finding to a scope with an approved price, through the real API.
 *
 * This is the step where the system first says a number out loud, so the tests that matter
 * are the refusals: before confirmation, before prerequisites are recorded, at a price the
 * catalogue does not carry, and past the delivery ceiling. The happy path is one test; the
 * ways it must not happen are the rest.
 */

let h: ApiHarness;
let scanId: string;
let findingId: string;
let opportunityId: string;
let offerId: string;

beforeAll(async () => {
  h = await createApiHarness();

  const admitted = await h.json<Scan>(
    await h.request('/api/v1/scans', { method: 'POST', body: JSON.stringify(scanRequest()) }),
  );
  scanId = admitted.id;
  await h.drain();
  const scan = await h.json<Scan>(await h.request(`/api/v1/scans/${scanId}`));
  findingId = scan.finding_ids[0]!;

  const cases = await h.json<{ items: Opportunity[] }>(await h.request('/api/v1/opportunities'));
  opportunityId = cases.items[0]!.id;
}, 180_000);

afterAll(async () => {
  await h?.stop();
  stopFixtureSite();
});

async function match(): Promise<OfferMatch> {
  return h.json<OfferMatch>(await h.request(`/api/v1/opportunities/${opportunityId}/offers`));
}

async function draft(
  body: Record<string, unknown> = { offer_id: offerId },
  subject = 'reviewer@fixture.test',
): Promise<Response> {
  return h.request(`/api/v1/opportunities/${opportunityId}/offer-drafts`, {
    method: 'POST',
    subject,
    body: JSON.stringify(body),
  });
}

describe('before the finding is confirmed', () => {
  it('offers nothing at all, and says why', async () => {
    const result = await match();
    expect(result.eligible).toEqual([]);
    expect(result.rejected).toEqual([{ sku: 'MF-LINK-REPAIR', reason: 'no_confirmed_finding' }]);
    // Not a quotation conversation: there is nothing established to quote about.
    expect(result.route_to_manual_quotation).toBe(false);
  });

  it('refuses to draft a scope for a candidate', async () => {
    const catalogue = await h.json<{ items: Offer[] }>(
      await h.request(`/api/v1/opportunities/${opportunityId}/offer-drafts`),
    );
    expect(catalogue.items).toEqual([]);

    // The offer id is knowable from the seeded catalogue even before anything is confirmed;
    // the refusal has to come from the case's state, not from the caller's ignorance.
    const response = await draft({ offer_id: LOCAL_FIXTURE.accountA });
    expect(response.status).toBe(404);
  });
});

describe('after confirmation', () => {
  it('moves the case to draft_offer once nothing is left to review', async () => {
    const before = await h.json<{ opportunity: Opportunity }>(
      await h.request(`/api/v1/opportunities/${opportunityId}`),
    );
    expect(before.opportunity.next_action).toBe('review_evidence');

    const review = await h.request(`/api/v1/findings/${findingId}/review`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        expected_version: 1,
        decision: 'confirm',
        reason: 'Both recorded checks returned 404 for the linked size guide.',
        acknowledged_limitations: true,
      }),
    });
    expect(review.status).toBe(200);
    expect((await h.json<Finding>(review)).state).toBe('confirmed');

    const after = await h.json<{ opportunity: Opportunity }>(
      await h.request(`/api/v1/opportunities/${opportunityId}`),
    );
    expect(after.opportunity.next_action).toBe('draft_offer');
  });

  it('matches the repair SKU at the price the owner approved', async () => {
    const result = await match();
    expect(result.eligible).toHaveLength(1);
    const eligible = result.eligible[0]!;
    offerId = eligible.offer.id;

    expect(eligible.offer.sku).toBe('MF-LINK-REPAIR');
    expect(eligible.offer.price).toEqual({
      currency: 'EUR',
      amount_minor: '29000',
      tax_treatment: 'net',
    });
    expect(eligible.offer.effort_band).toBe('1–3 h');
    expect(eligible.finding_ids).toEqual([findingId]);
    expect(eligible.root_cause_keys).toHaveLength(1);
  });

  it('is not draftable until the prerequisites are recorded', async () => {
    const result = await match();
    expect(result.eligible[0]!.draftable).toBe(false);
    // Named, so the operator knows what to go and settle.
    expect(result.eligible[0]!.unmet_prerequisites).toEqual([
      'authorized code/platform access',
      'agreed destination',
      'scope approval',
    ]);

    const response = await draft();
    expect(response.status).toBe(422);
    const problem = await h.json<{ code: string; detail: string }>(response);
    expect(problem.code).toBe('OFFER_PREREQUISITES_UNMET');
    expect(problem.detail).toContain('authorized code/platform access');
  });

  it('will not let a reviewer record a prerequisite on their own say-so', async () => {
    // Recording one is a claim about a customer relationship, not an observation. Owner only.
    const response = await h.request(
      `/api/v1/accounts/${LOCAL_FIXTURE.accountA}/offer-prerequisites`,
      {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({
          prerequisite: 'scope approval',
          note: 'Reviewer asserting a commercial fact they cannot establish.',
        }),
      },
    );
    expect(response.status).toBe(403);
  });

  it('becomes draftable once the owner records each prerequisite with a note', async () => {
    for (const prerequisite of [
      'authorized code/platform access',
      'agreed destination',
      'scope approval',
    ]) {
      const response = await h.request(
        `/api/v1/accounts/${LOCAL_FIXTURE.accountA}/offer-prerequisites`,
        {
          method: 'POST',
          subject: 'owner@fixture.test',
          body: JSON.stringify({
            prerequisite,
            note: `Synthetic fixture: ${prerequisite} confirmed in writing on 21 September 2026.`,
          }),
        },
      );
      expect(response.status, await response.clone().text()).toBe(201);
      const recorded = await h.json<OfferPrerequisite>(response);
      expect(recorded.revoked_at).toBeNull();
      // The note is the evidence for the claim and stays out of the projection.
      expect(Object.keys(recorded)).not.toContain('note');
    }

    const result = await match();
    expect(result.eligible[0]!.unmet_prerequisites).toEqual([]);
    expect(result.eligible[0]!.draftable).toBe(true);
  });
});

describe('drafting a scope', () => {
  let draftId: string;

  it('refuses a draft from an operator', async () => {
    const response = await draft({ offer_id: offerId }, 'operator@fixture.test');
    expect(response.status).toBe(403);
  });

  it('writes the price and scope as a snapshot, not a reference', async () => {
    const response = await draft();
    expect(response.status, await response.clone().text()).toBe(201);
    const created = await h.json<OfferDraft>(response);
    draftId = created.id;

    expect(created).toMatchObject({
      offer_sku: 'MF-LINK-REPAIR',
      offer_version: 1,
      state: 'draft',
      version: 1,
      opportunity_id: opportunityId,
    });
    expect(created.price).toEqual({
      currency: 'EUR',
      amount_minor: '29000',
      tax_treatment: 'net',
    });
    expect(created.finding_ids).toEqual([findingId]);
    // The scope travels with the draft so a later catalogue change cannot rewrite it.
    expect(created.snapshot).toMatchObject({
      promise: expect.stringContaining('Repair'),
      exclusions: expect.arrayContaining(['guaranteed revenue uplift']),
    });
  });

  it('refuses a second open draft for the same case and SKU', async () => {
    const response = await draft();
    expect(response.status).toBe(409);
    expect((await h.json<{ code: string }>(response)).code).toBe('OFFER_DRAFT_EXISTS');
  });

  it('counts the draft against delivery capacity', async () => {
    const result = await match();
    expect(result.open_commitments).toBe(1);
    expect(result.delivery_capacity).toBe(3);
    expect(result.capacity_reached).toBe(false);
  });

  it('withdraws with a reason, keeping the record', async () => {
    const response = await h.request(`/api/v1/offer-drafts/${draftId}/withdraw`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({ expected_version: 1, reason: 'Customer postponed the work.' }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const withdrawn = await h.json<OfferDraft>(response);
    expect(withdrawn.state).toBe('withdrawn');
    expect(withdrawn.withdraw_reason).toBe('Customer postponed the work.');
    expect(withdrawn.withdrawn_at).not.toBeNull();

    const listed = await h.json<{ items: OfferDraft[] }>(
      await h.request(`/api/v1/opportunities/${opportunityId}/offer-drafts`),
    );
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.state).toBe('withdrawn');
  });

  it('refuses to withdraw twice at the same version', async () => {
    const response = await h.request(`/api/v1/offer-drafts/${draftId}/withdraw`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({ expected_version: 1, reason: 'Second attempt.' }),
    });
    expect(response.status).toBe(409);
  });
});

describe('revoking what made it draftable', () => {
  it('stops the scope being draftable again', async () => {
    const response = await h.request(
      `/api/v1/accounts/${LOCAL_FIXTURE.accountA}/offer-prerequisites/revoke`,
      {
        method: 'POST',
        subject: 'owner@fixture.test',
        body: JSON.stringify({
          prerequisite: 'agreed destination',
          reason: 'The shop changed the destination page.',
        }),
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);

    const result = await match();
    expect(result.eligible[0]!.draftable).toBe(false);
    expect(result.eligible[0]!.unmet_prerequisites).toEqual(['agreed destination']);
    expect((await draft()).status).toBe(422);
  });
});

describe('tenant isolation', () => {
  it("will not show one workspace the other workspace's case", async () => {
    const response = await h.request(`/api/v1/opportunities/${opportunityId}/offers`, {
      subject: 'other-owner@fixture.test',
    });
    expect(response.status).toBe(404);
  });
});
