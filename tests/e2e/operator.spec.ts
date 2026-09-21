import {
  expect,
  request as apiRequest,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

/**
 * Operator browser acceptance and the design-critique screenshot set.
 *
 * QA.md requires: "Queue populated and empty; selected evidence with clear supported claim;
 * blocked scan; partial scan; review conflict; unavailable artifact; protected report;
 * settings cost limit; narrow mobile and keyboard focus."
 *
 * Screenshots land in `docs/design/screenshots/` and are the evidence behind the critique in
 * `docs/design/DESIGN_LOG.md`. They are captures of the real application against synthetic
 * fixture data — not mockups.
 */

const SHOTS = 'docs/design/screenshots';
const BASE_URL = 'http://127.0.0.1:4173';
/** The API process itself. The public intake surface is served here, not by the operator app. */
const API_URL = 'http://127.0.0.1:4174';
const FIXTURE_PRODUCT = 'http://127.0.0.1:4179/product';
/** The M2 fixture site; see fixtures/m2-server.mjs. */
const M2 = 'http://127.0.0.1:4180';
const ACCOUNT = '11111111-1111-4111-8111-000000000010';
const VENTURE = '11111111-1111-4111-8111-000000000001';
const AUTHORIZATION = '11111111-1111-4111-8111-000000000020';

/**
 * Sign in as one of the seeded fixture identities.
 *
 * The header is what the local API verifies; the stored value is what the app sends on its
 * own requests. Role and workspace still come from the database, so this chooses an
 * identity, not a permission.
 */
async function signIn(page: Page, subject: string) {
  // The context header covers `page.request` calls; the page header covers navigations; the
  // stored value covers requests the application itself makes.
  await page.context().setExtraHTTPHeaders({ 'x-fixture-subject': subject });
  await page.setExtraHTTPHeaders({ 'x-fixture-subject': subject });
  await page.addInitScript((value) => {
    window.localStorage.setItem('oe.fixtureSubject', value);
  }, subject);
}

/** Run one scan through the real API and wait for the runner to finish it. */
async function runScan(
  page: Page,
  targetUrl: string,
  detectors: string[] = ['MF-LINK-01'],
  maxPages = 2,
): Promise<string> {
  const session = await page.request.get('/api/v1/session');
  const { csrf_token: csrf } = (await session.json()) as { csrf_token: string };
  const created = await page.request.post('/api/v1/scans', {
    headers: {
      'x-csrf-token': csrf,
      'idempotency-key': crypto.randomUUID(),
      origin: 'http://127.0.0.1:4173',
    },
    data: {
      account_id: ACCOUNT,
      venture_id: VENTURE,
      target_url: targetUrl,
      authorization_id: AUTHORIZATION,
      max_unique_pages: maxPages,
      detectors,
      max_cost: { currency: 'USD', amount_micro: '100000' },
    },
  });
  expect(created.status(), await created.text()).toBe(202);
  const { id } = (await created.json()) as { id: string };

  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/v1/scans/${id}`);
        return ((await response.json()) as { state: string }).state;
      },
      { timeout: 45_000, intervals: [500] },
    )
    .not.toMatch(/queued|validating|capturing|analysing/);
  return id;
}

/** The MF-LINK-REPAIR scope's prerequisites, as the kit's catalogue states them. */
const PREREQUISITES = [
  'authorized code/platform access',
  'agreed destination',
  'scope approval',
] as const;

/**
 * Put the account back to "confirmed, nothing recorded".
 *
 * Withdraws any open draft and revokes any live prerequisite. Both are reversible, recorded
 * acts rather than deletions, so this leaves history behind exactly as a real withdrawal
 * would — which is the behaviour being tested, not a way around it.
 */
async function resetOfferState(
  page: Page,
  asOwner: APIRequestContext,
  ownerHeaders: Record<string, string>,
  opportunityId: string,
  reviewerCsrf: string,
): Promise<void> {
  const drafts = (await (
    await page.request.get(`/api/v1/opportunities/${opportunityId}/offer-drafts`)
  ).json()) as { items: { id: string; state: string; version: number }[] };
  for (const draft of drafts.items.filter((item) => item.state === 'draft')) {
    const response = await page.request.post(`/api/v1/offer-drafts/${draft.id}/withdraw`, {
      headers: {
        'x-csrf-token': reviewerCsrf,
        'idempotency-key': crypto.randomUUID(),
        origin: BASE_URL,
      },
      data: { expected_version: draft.version, reason: 'Resetting the browser fixture.' },
    });
    expect(response.status(), await response.text()).toBe(200);
  }

  const { csrf_token: ownerCsrf } = (await (
    await asOwner.get('/api/v1/session', { headers: ownerHeaders })
  ).json()) as { csrf_token: string };
  const recorded = (await (
    await asOwner.get(`/api/v1/accounts/${ACCOUNT}/offer-prerequisites`, {
      headers: ownerHeaders,
    })
  ).json()) as { items: { prerequisite: string; revoked_at: string | null }[] };
  for (const item of recorded.items.filter((row) => row.revoked_at === null)) {
    const response = await asOwner.post(`/api/v1/accounts/${ACCOUNT}/offer-prerequisites/revoke`, {
      headers: {
        ...ownerHeaders,
        'x-csrf-token': ownerCsrf,
        'idempotency-key': crypto.randomUUID(),
      },
      data: { prerequisite: item.prerequisite, reason: 'Resetting the browser fixture.' },
    });
    expect(response.status(), await response.text()).toBe(200);
  }
}

test.describe('operator journey', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'reviewer@fixture.test');
  });

  test('queue, case, review and report', async ({ page }, testInfo) => {
    const desktop = testInfo.project.name === 'desktop';
    const scanId = await runScan(page, FIXTURE_PRODUCT);
    const scan = await (await page.request.get(`/api/v1/scans/${scanId}`)).json();
    const findingId = (scan as { finding_ids: string[] }).finding_ids[0]!;

    // --- queue -----------------------------------------------------------
    await page.goto('/opportunities');
    await expect(page.getByRole('heading', { name: 'Review queue', level: 1 })).toBeVisible();
    const caseLink = page
      .getByRole('link', { name: /Linked information page returns an error/ })
      .first();
    await expect(caseLink).toBeVisible();
    // An unknown input shows as an interval, never as a zero or a fake point score.
    await expect(page.locator('.caserow').first()).toContainText('% of inputs known');
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-queue.png`, fullPage: true });

    // --- case ------------------------------------------------------------
    await caseLink.click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Atelier Nord');
    // Review the finding this test produced, not whichever one sorts first.
    await page.goto(`${new URL(page.url()).pathname}?finding=${findingId}`);

    if (!desktop) {
      await page.getByRole('tab', { name: 'Evidence' }).click();
    }

    // The matrix is the composition's centrepiece: two rows, two sessions, four cells.
    const cells = page.locator('.matrix .cell');
    await expect(cells).toHaveCount(4);
    await expect(page.locator('.agreement')).toContainText('Both independent checks returned 404');

    // Selecting a cell loads its artifact.
    await cells.nth(2).click();
    await expect(page.locator('.stage img')).toBeVisible();
    await page.screenshot({
      path: `${SHOTS}/${testInfo.project.name}-case-evidence.png`,
      fullPage: true,
    });

    // --- provenance ------------------------------------------------------
    await page.locator('.sourcestrip summary').click();
    await expect(page.locator('.sourcestrip dl')).toContainText('Session');
    await page.locator('.sourcestrip summary').click();

    // --- the claim and its limits ---------------------------------------
    if (!desktop) await page.getByRole('tab', { name: 'Finding' }).click();
    await expect(page.locator('.narrative .claim')).toContainText('404');
    await expect(page.locator('.narrative')).toContainText('Limits of this evidence');
    // The commercial reading is labelled a hypothesis, never a measured effect.
    await expect(page.locator('.narrative')).toContainText('not a measured effect on sales');

    // --- review seam -----------------------------------------------------
    if (!desktop) await page.getByRole('tab', { name: 'Decision' }).click();
    const confirm = page.getByRole('button', { name: 'Confirm finding' });
    await expect(confirm).toBeDisabled();

    await page
      .getByLabel('Reviewer note')
      .fill('Both recorded checks returned 404 for the linked size guide.');
    // Still disabled: the limits have not been acknowledged.
    await expect(confirm).toBeDisabled();
    await page.getByRole('checkbox').check();
    await expect(confirm).toBeEnabled();
    await page.screenshot({
      path: `${SHOTS}/${testInfo.project.name}-review-seam.png`,
      fullPage: true,
    });

    await confirm.click();
    await expect(page.getByText('Confirmed by a reviewer')).toBeVisible();

    // --- report ----------------------------------------------------------
    await page.getByRole('button', { name: 'Compose report' }).click();
    await page.getByRole('link', { name: 'Open the report' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Atelier Nord');
    await expect(page.locator('.report')).toContainText('What we inspected');
    await expect(page.locator('.report')).toContainText('What this does not establish');
    await expect(page.locator('.report')).toContainText('has not been measured');
    // A draft cannot be published without approval; the button offers approval only.
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('button', { name: 'Publish version' }).click();
    await expect(page.locator('.chip')).toContainText('published');
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-report.png`, fullPage: true });
  });

  /**
   * The catalogue step, in the browser.
   *
   * The assertion that matters is negative: there is no price input anywhere on this screen,
   * and the button that would commit to a number is disabled until an owner has recorded the
   * prerequisites. A reviewer cannot type a price into this application at all.
   */
  test('a confirmed case offers only scopes an owner priced', async ({ page }, testInfo) => {
    const scanId = await runScan(page, FIXTURE_PRODUCT);
    const scan = (await (await page.request.get(`/api/v1/scans/${scanId}`)).json()) as {
      finding_ids: string[];
    };
    const findingId = scan.finding_ids[0]!;
    const { csrf_token: csrf } = (await (await page.request.get('/api/v1/session')).json()) as {
      csrf_token: string;
    };
    const confirmed = await page.request.post(`/api/v1/findings/${findingId}/review`, {
      headers: {
        'x-csrf-token': csrf,
        'idempotency-key': crypto.randomUUID(),
        origin: 'http://127.0.0.1:4173',
      },
      data: {
        expected_version: 1,
        decision: 'confirm',
        reason: 'Both recorded checks returned 404 for the linked size guide.',
        acknowledged_limitations: true,
      },
    });
    expect(confirmed.status(), await confirmed.text()).toBe(200);

    // The case that holds THIS finding. Every scan of the same fixture page rolls into one
    // case, so a run with several scans leaves other findings still awaiting a decision —
    // which is why `next_action` is asserted in the integration suite, against a clean
    // database, rather than here.
    const opportunities = (await (await page.request.get('/api/v1/opportunities')).json()) as {
      items: { id: string; finding_ids: string[] }[];
    };
    const opportunity = opportunities.items.find((item) => item.finding_ids.includes(findingId));
    expect(opportunity, 'the confirmed finding should belong to a case').toBeDefined();

    // This suite runs twice, desktop and narrow, against one seeded database, and the whole
    // point of the test is the journey from "nothing recorded" to "drafted". So it puts the
    // account back to nothing recorded before opening the page, rather than asserting
    // whatever the previous project left behind.
    const asOwner = await apiRequest.newContext({ baseURL: BASE_URL });
    const ownerHeaders = { 'x-fixture-subject': 'owner@fixture.test', origin: BASE_URL };
    await resetOfferState(page, asOwner, ownerHeaders, opportunity!.id, csrf);

    await page.goto(`/opportunities/${opportunity!.id}?finding=${findingId}`);
    if (testInfo.project.name !== 'desktop') {
      await page.getByRole('tab', { name: 'Decision' }).click();
    }

    const offer = page.locator('.offer').first();
    await expect(offer).toContainText('MF-LINK-REPAIR');
    await expect(offer.locator('.offer-price')).toContainText('290.00 EUR net');
    // The scope's exclusions are on screen with its price. A promise and its limits travel
    // together or the limits are decoration.
    await expect(offer).toContainText('guaranteed revenue uplift');

    // Nowhere to type a price, and nothing to draft yet.
    await expect(page.locator('.offer input[type="number"]')).toHaveCount(0);
    await expect(offer).toContainText('Prerequisites not recorded');
    for (const prerequisite of PREREQUISITES) await expect(offer).toContainText(prerequisite);
    await expect(page.getByRole('button', { name: 'Draft this scope' })).toBeDisabled();
    // The reason is on the card. A scope must not read as both on offer and unavailable.
    await expect(page.getByText(/scopes? (is|are) unavailable/)).toHaveCount(0);
    await page.screenshot({
      path: `${SHOTS}/${testInfo.project.name}-scope-blocked.png`,
      fullPage: true,
    });

    // An owner records each prerequisite with a note. Only then does the button open.
    // Its own request context, not the page's: the page is signed in as the reviewer, and the
    // CSRF token is bound to the subject it was issued to — a reviewer's token does not
    // authorise an owner's request, which is exactly what binding it is for.
    const ownerSession = (await (
      await asOwner.get('/api/v1/session', { headers: ownerHeaders })
    ).json()) as { role: string; csrf_token: string };
    expect(ownerSession.role).toBe('owner');

    for (const prerequisite of PREREQUISITES) {
      const recorded = await asOwner.post(`/api/v1/accounts/${ACCOUNT}/offer-prerequisites`, {
        headers: {
          ...ownerHeaders,
          'x-csrf-token': ownerSession.csrf_token,
          'idempotency-key': crypto.randomUUID(),
        },
        data: {
          prerequisite,
          note: `Synthetic fixture: ${prerequisite} confirmed in writing on 21 September 2026.`,
        },
      });
      expect(recorded.status(), await recorded.text()).toBe(201);
    }

    await page.reload();
    if (testInfo.project.name !== 'desktop') {
      await page.getByRole('tab', { name: 'Decision' }).click();
    }
    const draft = page.getByRole('button', { name: 'Draft this scope' });
    await expect(draft).toBeEnabled();
    await draft.click();

    await expect(page.getByText('MF-LINK-REPAIR drafted')).toBeVisible();
    await expect(page.locator('.offer[data-state="draft"]')).toContainText(
      'A later catalogue change does not reprice',
    );
    await page.screenshot({
      path: `${SHOTS}/${testInfo.project.name}-scope-drafted.png`,
      fullPage: true,
    });

    // Withdrawal needs a reason; the control refuses an empty one.
    const withdraw = page.getByRole('button', { name: 'Withdraw', exact: true });
    await expect(withdraw).toBeDisabled();
    await page.getByLabel('Withdraw this draft').fill('Customer postponed the work.');
    await expect(withdraw).toBeEnabled();

    await asOwner.dispose();
  });

  test('a requested check arrives as a claim, not as permission', async ({ page }, testInfo) => {
    // Submitted the way a venture site would: straight at the API, with the forwarded host a
    // proxy would set. The host decides the workspace, and there is no tenant field in the
    // body to decide it any other way.
    const publicApi = await apiRequest.newContext({ baseURL: API_URL });
    const asSite = {
      host: 'intake-a.fixture.test',
      'x-forwarded-host': 'intake-a.fixture.test',
      origin: 'https://intake-a.fixture.test',
    };
    const unique = Date.now();
    let requestId: string;
    try {
      const submitted = await publicApi.post('/public/intake', {
        headers: asSite,
        data: {
          target_url: `https://shop-${unique}.example.com/products/jacket`,
          requested_detectors: ['MF-LINK-01'],
          purpose: 'Customers tell us the size guide link on our product page is broken.',
          authority_claim: 'I am the owner of this shop and I am asking for this check myself.',
          contact_email: `requester-${unique}@example.com`,
        },
      });
      expect(submitted.status(), await submitted.text()).toBe(201);
      const created = (await submitted.json()) as { id: string; local_verification_code: string };
      requestId = created.id;

      const verified = await publicApi.post(`/public/intake/${created.id}/verify`, {
        headers: asSite,
        data: { code: created.local_verification_code },
      });
      expect(verified.status(), await verified.text()).toBe(200);
      expect(((await verified.json()) as { state: string }).state).toBe('received');
    } finally {
      await publicApi.dispose();
    }

    await signIn(page, 'reviewer@fixture.test');
    await page.goto('/requests');
    await expect(page.getByRole('heading', { name: 'Requested checks', level: 1 })).toBeVisible();

    // Filtered to this test's own request, not `.first()`: a shared fixture database can hold
    // other verified requests, and a run that asserted against whichever sorted first would
    // pass or fail depending on what ran before it.
    const card = page.locator('.request').filter({ hasText: `shop-${unique}.example.com` });
    await expect(card).toHaveCount(1);
    await expect(card.locator('.chip')).toContainText('address confirmed');

    // The screen has to keep "asked" and "allowed" apart, in words.
    await expect(card).toContainText('Confirmed address, no authority yet');
    await expect(card).toContainText('says nothing about whether they control');
    await expect(card.locator('.request-claim footer')).toContainText('not established as a fact');
    // And it must not imply consent to anything beyond answering this request.
    await expect(card).toContainText('not agreeing to be marketed to');

    await page.screenshot({
      path: `${SHOTS}/${testInfo.project.name}-requests.png`,
      fullPage: true,
    });

    // Declining needs a reason; the control refuses an empty one.
    const decline = card.getByRole('button', { name: 'Decline', exact: true });
    await expect(decline).toBeDisabled();
    await card.getByLabel('Decline this request').fill('We cannot establish site control.');
    await expect(decline).toBeEnabled();
    await decline.click();

    // And the requester learns only that it is closed.
    const closed = await apiRequest.newContext({ baseURL: API_URL });
    try {
      const view = await closed.get(`/public/intake/${requestId}`, { headers: asSite });
      expect(((await view.json()) as { state: string }).state).toBe('closed');
    } finally {
      await closed.dispose();
    }
  });

  /**
   * The delivery seam, in the browser.
   *
   * The assertions that matter are about what the screen says as much as what it does: the
   * token is shown once, issuing sends nothing, and a withdrawn link stops working on the very
   * next read with no session to wait out.
   */
  test('a published report can be shared by link, and the link withdrawn', async ({
    page,
  }, testInfo) => {
    const scanId = await runScan(page, FIXTURE_PRODUCT);
    const scan = (await (await page.request.get(`/api/v1/scans/${scanId}`)).json()) as {
      finding_ids: string[];
      account_id: string;
    };
    const findingId = scan.finding_ids[0]!;
    const { csrf_token: csrf } = (await (await page.request.get('/api/v1/session')).json()) as {
      csrf_token: string;
    };
    const post = (path: string, data: unknown) =>
      page.request.post(path, {
        headers: {
          'x-csrf-token': csrf,
          'idempotency-key': crypto.randomUUID(),
          origin: BASE_URL,
        },
        data,
      });

    const confirmed = await post(`/api/v1/findings/${findingId}/review`, {
      expected_version: 1,
      decision: 'confirm',
      reason: 'Both recorded checks returned 404 for the linked size guide.',
      acknowledged_limitations: true,
    });
    expect(confirmed.status(), await confirmed.text()).toBe(200);
    const finding = (await confirmed.json()) as { id: string; version: number };

    const created = await post('/api/v1/reports', {
      account_id: scan.account_id,
      scan_id: scanId,
      finding_versions: [{ finding_id: finding.id, version: finding.version }],
      language: 'en',
      scope_summary: 'We inspected one product page and the information page linked from it.',
    });
    expect(created.status(), await created.text()).toBe(201);
    const reportId = ((await created.json()) as { id: string }).id;

    await page.goto(`/reports/${reportId}`);
    // A draft cannot be delivered, and the screen says why rather than hiding the control.
    await expect(page.getByLabel('Who is this link for')).toHaveCount(0);
    await expect(page.locator('section[aria-label="Protected links"]')).toContainText(
      'Only a published version can be delivered',
    );

    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('button', { name: 'Publish version' }).click();
    await expect(page.locator('.chip').first()).toContainText('published');

    await page.getByLabel('Who is this link for').fill('the person who requested the check');
    const issue = page.getByRole('button', { name: 'Issue a protected link' });
    // Both fields are needed: a link nobody can later identify is a link nobody can withdraw.
    await expect(issue).toBeDisabled();
    await page.getByLabel('Their address, for your own records').fill('requester@example.com');
    await expect(issue).toBeEnabled();
    await issue.click();

    await expect(page.getByText('Copy this link now')).toBeVisible();
    await expect(page.locator('.notice[data-tone="attention"]')).toContainText('shown once');
    await page.screenshot({
      path: `${SHOTS}/${testInfo.project.name}-report-link.png`,
      fullPage: true,
    });

    // The link works, and carries nothing that reaches another object.
    const url = (
      await page
        .locator('section[aria-label="Protected links"] p')
        .filter({ hasText: '/r/' })
        .first()
        .innerText()
    ).trim();
    const reader = await apiRequest.newContext();
    try {
      const delivered = await reader.get(url);
      expect(delivered.status(), await delivered.text()).toBe(200);
      expect(delivered.headers()['content-type']).toContain('text/html');
      expect(delivered.headers()['x-robots-tag']).toContain('noindex');
      const html = await delivered.text();
      // The customer reads what was checked, what was found and what none of it establishes.
      expect(html).toContain('What we inspected');
      expect(html).toContain('What this does not establish');
      // And nothing that reaches another object, nor anything to execute.
      expect(html).not.toContain('/api/v1/');
      expect(html).not.toMatch(/<script/i);

      // Withdrawing takes effect on the next read. There is no session to expire.
      await page.getByRole('button', { name: 'Done' }).click();
      await page.getByLabel('Withdraw this link').fill('Sent to the wrong address.');
      await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
      await expect(page.locator('.grant[data-state="revoked"]')).toBeVisible();

      const after = await reader.get(url);
      expect(after.status()).toBe(404);
      // The same page a mistyped link gets, saying nothing about what was there or why it
      // stopped working.
      const withdrawn = await after.text();
      expect(withdrawn).toContain('This link is not available');
      expect(withdrawn).not.toContain('Atelier Nord');
      expect(withdrawn).not.toMatch(/revoked|withdrawn by/i);
    } finally {
      await reader.dispose();
    }
  });

  test('a blocked scan explains itself and produces no finding', async ({ page }, testInfo) => {
    // A challenge page answers instead of the product page.
    const scanId = await runScan(page, 'http://127.0.0.1:4179/challenge');
    await page.goto(`/scans/${scanId}`);
    await expect(page.getByRole('heading', { name: 'Scan record' })).toBeVisible();
    await expect(
      page.locator('.notice[data-tone="blocked"], .notice[data-tone="attention"]'),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText('404');
    await page.screenshot({
      path: `${SHOTS}/${testInfo.project.name}-scan-blocked.png`,
      fullPage: true,
    });
  });

  test('a healthy page reports no supported defect rather than good health', async ({ page }) => {
    const scanId = await runScan(page, 'http://127.0.0.1:4179/healthy-product');
    await page.goto(`/scans/${scanId}`);
    await expect(page.locator('.coverage .fraction')).toContainText('2 of 2 pages');
    await expect(page.locator('.coverage')).toContainText('loaded in both recorded checks');
    // The narrative never generalises from the sample. (The word "healthy" appears only in
    // the fixture's own URL, so the assertion is scoped to the copy the operator reads.)
    await expect(page.locator('.coverage')).toContainText(
      'This is a sample, not a whole-store inspection',
    );
    await expect(page.locator('.coverage')).not.toContainText(/healthy|no issues|all good/i);
  });

  test('review conflict preserves the typed note', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'One projection of this scenario is enough.');
    const scanId = await runScan(page, FIXTURE_PRODUCT);
    const scan = await (await page.request.get(`/api/v1/scans/${scanId}`)).json();
    const findingId = (scan as { finding_ids: string[] }).finding_ids[0]!;

    const opportunities = await (await page.request.get('/api/v1/opportunities?limit=100')).json();
    const target = (opportunities as { items: { id: string; finding_ids: string[] }[] }).items.find(
      (item) => item.finding_ids.includes(findingId),
    )!;
    // Deep-link to the finding under test: one opportunity groups every finding sharing a
    // root cause, so the case has to be told which one is being reviewed.
    await page.goto(`/opportunities/${target.id}?finding=${findingId}`);

    await page.getByLabel('Reviewer note').fill('A careful note that must survive the conflict.');
    await page.getByRole('checkbox').check();

    // Another reviewer decides the same version first, out of band.
    const session = await (await page.request.get('/api/v1/session')).json();
    const rejected = await page.request.post(`/api/v1/findings/${findingId}/review`, {
      headers: {
        'x-csrf-token': (session as { csrf_token: string }).csrf_token,
        'idempotency-key': crypto.randomUUID(),
        origin: 'http://127.0.0.1:4173',
      },
      data: {
        expected_version: 1,
        decision: 'reject',
        reason: 'Decided first from another session.',
        acknowledged_limitations: true,
      },
    });
    expect(rejected.status()).toBe(200);

    await page.getByRole('button', { name: 'Confirm finding' }).click();
    await expect(page.getByText('This finding changed while you were reviewing')).toBeVisible();
    await expect(page.getByLabel('Reviewer note')).toHaveValue(
      'A careful note that must survive the conflict.',
    );
    await page.screenshot({ path: `${SHOTS}/desktop-review-conflict.png`, fullPage: true });
  });

  test('an unavailable artifact states why, and the observation still stands', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'One projection of this scenario is enough.');
    const scanId = await runScan(page, FIXTURE_PRODUCT);
    const scan = await (await page.request.get(`/api/v1/scans/${scanId}`)).json();

    // Target the observation the first matrix cell shows: the inspected page, session one.
    const timeline = await (await page.request.get(`/api/v1/scans/${scanId}/timeline`)).json();
    const firstCell = (
      timeline as { evidence: { id: string; conditions: { session_id: string } }[] }
    ).evidence.find((item) => item.conditions.session_id.endsWith(':source_page:1'))!;

    // Intercept only that artifact so the page renders its unavailable branch while every
    // other observation stays readable.
    await page.route(`**/api/v1/evidence/${firstCell.id}/content`, (route) =>
      route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{}' }),
    );

    const opportunities = await (await page.request.get('/api/v1/opportunities?limit=100')).json();
    const target = (opportunities as { items: { id: string; finding_ids: string[] }[] }).items.find(
      (item) => item.finding_ids.includes((scan as { finding_ids: string[] }).finding_ids[0]!),
    )!;
    await page.goto(`/opportunities/${target.id}?finding=${evidenceOwner(scan)}`);
    // Click the row the interception applies to. The grid puts the finding's own target
    // first, which for a link finding is the destination, not the page.
    await page
      .locator('.matrix tbody tr')
      .filter({ hasText: 'Inspected page' })
      .locator('.cell')
      .first()
      .click();
    await expect(page.locator('.stage .unavailable')).toContainText('cannot be shown');
    await expect(page.locator('.stage')).toContainText(
      'The recorded observation below is unaffected',
    );
    await page.screenshot({ path: `${SHOTS}/desktop-artifact-unavailable.png`, fullPage: true });
  });
});

/** The finding the scan under test produced, used for deep links. */
function evidenceOwner(scan: unknown): string {
  return (scan as { finding_ids: string[] }).finding_ids[0]!;
}

test.describe('MF-ASSET-01 in the workbench', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'reviewer@fixture.test');
  });

  test('a broken product image reads as a grid of what loaded and what did not', async ({
    page,
  }, testInfo) => {
    const scanId = await runScan(page, `${M2}/product-broken-image`, ['MF-ASSET-01'], 1);
    const scan = await (await page.request.get(`/api/v1/scans/${scanId}`)).json();
    const findingId = (scan as { finding_ids: string[] }).finding_ids[0]!;

    const opportunities = await (await page.request.get('/api/v1/opportunities?limit=100')).json();
    const target = (opportunities as { items: { id: string; finding_ids: string[] }[] }).items.find(
      (item) => item.finding_ids.includes(findingId),
    )!;
    await page.goto(`/opportunities/${target.id}?finding=${findingId}`);

    if (testInfo.project.name !== 'desktop') {
      await page.getByRole('tab', { name: 'Evidence' }).click();
    }

    // The page and both of its images each get a row; two clean sessions each.
    const rows = page.locator('.matrix tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(page.locator('.matrix .cell')).toHaveCount(6);

    // The failing image leads, and the agreement line describes what a shopper would see.
    await expect(rows.first()).toContainText('Product image');
    await expect(rows.first()).toContainText('missing.png');
    await expect(page.locator('.agreement')).toContainText('Neither independent check rendered');

    // A 200 that never painted is a failure cell, not a success one.
    const firstCells = rows.first().locator('.cell');
    await expect(firstCells.first()).toContainText('did not render');
    await expect(firstCells.first()).toHaveAttribute('data-verdict', 'failure');

    // The image that did load is shown as loaded, and its artifact opens.
    const loadedRow = rows.filter({ hasText: 'detail.png' });
    await expect(loadedRow.locator('.cell').first()).toContainText('rendered on the page');
    await loadedRow.locator('.cell').first().click();
    await expect(page.locator('.stage img')).toBeVisible();

    if (testInfo.project.name !== 'desktop')
      await page.getByRole('tab', { name: 'Finding' }).click();
    await expect(page.locator('.narrative .claim')).toContainText('HTTP 404');
    await expect(page.locator('.narrative')).toContainText('Limits of this evidence');
    await page.screenshot({
      path: `${SHOTS}/${testInfo.project.name}-case-asset.png`,
      fullPage: true,
    });
  });

  test('a decorative failure is recorded but never claimed', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'One projection of this scenario is enough.');
    const scanId = await runScan(page, `${M2}/product-decorative-broken`, ['MF-ASSET-01'], 1);
    await page.goto(`/scans/${scanId}`);
    await expect(page.locator('.coverage')).toContainText('1 classified as product content');
    // No finding, and nothing on the page calls the decorative failure a defect.
    await expect(page.locator('body')).not.toContainText('did not load');
    await page.screenshot({ path: `${SHOTS}/desktop-scan-asset-decorative.png`, fullPage: true });
  });

  test('a slow image is reported as pending, never as broken', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'One projection of this scenario is enough.');
    const scanId = await runScan(page, `${M2}/product-lazy`, ['MF-ASSET-01'], 1);
    await page.goto(`/scans/${scanId}`);
    await expect(page.locator('.coverage')).toContainText(
      'still loading when the bounded wait expired',
    );
    await expect(page.locator('.coverage')).not.toContainText(/did not load|broken/i);
  });
});

test.describe('workspace surfaces', () => {
  test('settings shows cost limits and states what is absent', async ({ page }, testInfo) => {
    await signIn(page, 'owner@fixture.test');
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Cost limits' })).toBeVisible();
    // Workspace and venture ceilings are the owner's controls; per-scan caps belong to the
    // scan and are summarised rather than listed one row each.
    await expect(page.locator('.panel').first()).toContainText('tenant');
    await expect(page.locator('.panel').first()).toContainText('venture');
    await expect(page.locator('body')).toContainText('Not available in this build');
    await expect(page.locator('body')).toContainText('Outbound messaging of any kind');
    await page.screenshot({
      path: `${SHOTS}/${testInfo.project.name}-settings.png`,
      fullPage: true,
    });
  });

  test('a viewer can read but not act', async ({ page }) => {
    await signIn(page, 'viewer@fixture.test');
    await page.goto('/opportunities');
    await expect(page.getByRole('link', { name: 'New scan' })).toHaveCount(0);
  });

  test('the new-scan form refuses an unapproved host before submitting', async ({
    page,
  }, testInfo) => {
    await signIn(page, 'operator@fixture.test');
    await page.goto('/scans/new');
    await page.getByLabel('Approved account').selectOption({ index: 1 });
    await page.getByLabel('Page to inspect').fill('https://somewhere-else.example.com/product');
    await expect(page.getByRole('alert')).toContainText('not an approved host');
    await expect(page.getByRole('button', { name: 'Confirm bounded scan' })).toBeDisabled();
    await page.screenshot({
      path: `${SHOTS}/${testInfo.project.name}-new-scan-blocked.png`,
      fullPage: true,
    });
  });

  test('the composition studies render both alternatives on the same content', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'The studies are a desktop design artifact.');
    await signIn(page, 'reviewer@fixture.test');
    await page.goto('/design-studies');
    await expect(page.getByRole('heading', { name: 'Composition studies' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/study-a-agreement-first.png`, fullPage: true });
    await page.getByRole('button', { name: 'B · Document first' }).click();
    await expect(page.locator('body')).toContainText('Citations');
    await page.screenshot({ path: `${SHOTS}/study-b-document-first.png`, fullPage: true });
  });
});

test.describe('accessibility behaviour', () => {
  test('keyboard reaches the case and the artifact viewer returns focus', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Keyboard path is checked once.');
    await signIn(page, 'reviewer@fixture.test');
    await runScan(page, FIXTURE_PRODUCT);
    await page.goto('/opportunities');

    // Tab from the top: the skip link is first, and every stop is visible.
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();

    await page
      .getByRole('link', { name: /Linked information page returns an error/ })
      .first()
      .click();
    await page.locator('.matrix .cell').nth(2).click();

    const enlarge = page.getByRole('button', { name: 'Enlarge' });
    await enlarge.focus();
    await page.screenshot({ path: `${SHOTS}/desktop-keyboard-focus.png`, fullPage: true });
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Escape restores focus to the control that opened the layer.
    await expect(enlarge).toBeFocused();
  });

  test('every interactive control has an accessible name', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Checked once per build.');
    await signIn(page, 'reviewer@fixture.test');
    await page.goto('/opportunities');
    const unnamed = await page.evaluate(() => {
      const problems: string[] = [];
      for (const element of document.querySelectorAll('button, a, input, select, textarea')) {
        const label =
          element.getAttribute('aria-label') ??
          element.getAttribute('title') ??
          (element as HTMLElement).innerText?.trim() ??
          '';
        const labelled =
          label.length > 0 ||
          Boolean(element.id && document.querySelector(`label[for="${element.id}"]`)) ||
          Boolean(element.closest('label'));
        if (!labelled) problems.push(element.outerHTML.slice(0, 120));
      }
      return problems;
    });
    expect(unnamed).toEqual([]);
  });
});
