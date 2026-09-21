import { expect, test, type Page } from '@playwright/test';

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
