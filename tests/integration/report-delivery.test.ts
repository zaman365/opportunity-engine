import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DeliveredReport,
  Finding,
  IssuedReportGrant,
  Report,
  ReportGrant,
  ReportGrants,
  Scan,
} from '@oe/contracts';
import pg from 'pg';
import {
  createApiHarness,
  LOCAL_FIXTURE,
  scanRequest,
  stopFixtureSite,
  type ApiHarness,
} from '../support/api-harness.ts';
import { requireDatabaseUrls } from '../support/harness.ts';

/**
 * Getting a reviewed report to the person it is about, without giving them a seat.
 *
 * M3's gate: "Report links have expiry/revocation, protected evidence and a non-leaking
 * invalid-link page... GET tokens never mutate data; prevent replay and cross-report use."
 *
 * The clock is injected, so expiry is asserted at the second rather than waited for.
 */

let h: ApiHarness;

/**
 * A real clock, deliberately.
 *
 * A frozen one breaks the preconditions of the thing under test: the detector requires two
 * *independent* sessions, and a stopped clock makes both captures indistinguishable, so the
 * finding comes back `unknown` and there is nothing to report on. Expiry is tested by moving
 * the row, which is where the enforcement actually lives.
 */
const now = () => new Date();

let reportId: string;
let publishedVersion: number;
let issued: IssuedReportGrant;

beforeAll(async () => {
  h = await createApiHarness({ now });

  const admitted = await h.json<Scan>(
    await h.request('/api/v1/scans', { method: 'POST', body: JSON.stringify(scanRequest()) }),
  );
  await h.drain();
  const scan = await h.json<Scan>(await h.request(`/api/v1/scans/${admitted.id}`));
  const findingId = scan.finding_ids[0]!;

  const reviewed = await h.request(`/api/v1/findings/${findingId}/review`, {
    method: 'POST',
    subject: 'reviewer@fixture.test',
    body: JSON.stringify({
      expected_version: 1,
      decision: 'confirm',
      reason: 'Both recorded checks returned 404 for the linked size guide.',
      acknowledged_limitations: true,
    }),
  });
  expect(reviewed.status, await reviewed.clone().text()).toBe(200);
  const finding = await h.json<Finding>(reviewed);

  const created = await h.json<Report>(
    await h.request('/api/v1/reports', {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        account_id: scan.account_id,
        scan_id: scan.id,
        finding_versions: [{ finding_id: finding.id, version: finding.version }],
        language: 'en',
        scope_summary: 'We inspected one product page and the information page linked from it.',
      }),
    }),
  );
  reportId = created.id;
}, 180_000);

afterAll(async () => {
  await h?.stop();
  stopFixtureSite();
});

async function read(token: string): Promise<Response> {
  return await h.app.fetch(new Request(`http://127.0.0.1:4173/public/reports/${token}`));
}

/**
 * A migration-role connection, for moving a row the application deliberately cannot move.
 *
 * `expires_at` is written once and never updated by the runtime role — that is the point, so a
 * link's lifetime cannot be shortened or extended after somebody was given it. Reaching past
 * the application is therefore the only honest way to test what happens when time passes.
 */
async function withMigrationClient(body: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: requireDatabaseUrls().migration });
  await client.connect();
  try {
    await body(client);
  } finally {
    await client.end();
  }
}

async function publish(): Promise<void> {
  for (const step of ['approve', 'publish']) {
    const current = await h.json<Report>(await h.request(`/api/v1/reports/${reportId}`));
    const response = await h.request(`/api/v1/reports/${reportId}/${step}`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({ expected_version: current.version }),
    });
    expect(response.status, `${step}: ${await response.clone().text()}`).toBe(200);
  }
  // Each transition bumps the version, so the published version is not 1. Read it rather
  // than assuming it: the point of the binding is that the grant names whatever was actually
  // published, and a test that hard-coded the number would stop checking that.
  publishedVersion = (await h.json<Report>(await h.request(`/api/v1/reports/${reportId}`))).version;
}

describe('before the report is published', () => {
  it('refuses to issue a link to a draft', async () => {
    // A draft is a working document. Delivering one would put a version in front of a
    // customer that nobody decided to show them.
    const response = await h.request(`/api/v1/reports/${reportId}/grants`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        recipient_note: 'the person who requested the check',
        recipient_ref: 'requester@example.com',
      }),
    });
    expect(response.status).toBe(409);
    expect((await h.json<{ code: string }>(response)).code).toBe('INVALID_TRANSITION');
  });
});

describe('issuing a link', () => {
  beforeAll(publish);

  it('refuses an operator', async () => {
    // Deciding that a customer may read a claim is the same rank of act as making the claim.
    const response = await h.request(`/api/v1/reports/${reportId}/grants`, {
      method: 'POST',
      subject: 'operator@fixture.test',
      body: JSON.stringify({ recipient_note: 'x y z', recipient_ref: 'requester@example.com' }),
    });
    expect(response.status).toBe(403);
  });

  it('returns the token exactly once', async () => {
    const response = await h.request(`/api/v1/reports/${reportId}/grants`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({
        recipient_note: 'the person who requested the check',
        recipient_ref: 'requester@example.com',
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    issued = await h.json<IssuedReportGrant>(response);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(issued.url).toContain(issued.token);
    expect(issued.grant.state).toBe('live');
    expect(issued.grant.report_version).toBe(publishedVersion);

    // The list is the only other way to see a grant, and it carries no token.
    const listed = await h.json<ReportGrants>(
      await h.request(`/api/v1/reports/${reportId}/grants`),
    );
    expect(listed.items).toHaveLength(1);
    expect(Object.keys(listed.items[0]!)).not.toContain('token');
    // Nor the recipient's address: the note is what an operator reads.
    expect(JSON.stringify(listed.items[0])).not.toContain('requester@example.com');
  });

  it('returns the same link on a retried request rather than minting a second', async () => {
    const key = 'idem-issue-grant-0001';
    const body = JSON.stringify({
      recipient_note: 'retry case',
      recipient_ref: 'retry@example.com',
    });
    const first = await h.json<IssuedReportGrant>(
      await h.request(`/api/v1/reports/${reportId}/grants`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        headers: { 'idempotency-key': key },
        body,
      }),
    );
    const replay = await h.json<IssuedReportGrant>(
      await h.request(`/api/v1/reports/${reportId}/grants`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        headers: { 'idempotency-key': key },
        body,
      }),
    );
    // Two live links where the operator meant one is the failure this prevents.
    expect(replay.grant.id).toBe(first.grant.id);
    expect(replay.token).toBe(first.token);
  });
});

describe('reading through the link', () => {
  it('serves the published body and nothing that reaches anything else', async () => {
    const response = await read(issued.token);
    expect(response.status, await response.clone().text()).toBe(200);
    const delivered = await h.json<DeliveredReport>(response);

    expect(delivered.report_version).toBe(publishedVersion);
    expect(delivered.language).toBe('en');
    expect(delivered.published_at).not.toBeNull();
    expect(delivered.expires_at).toBe(issued.grant.expires_at);

    // The substance is there.
    const body = delivered.body as Record<string, unknown>;
    expect(body['scope_summary']).toContain('inspected');
    expect(Array.isArray(body['limitations'])).toBe(true);

    // And nothing that would let the holder reach another object.
    const keys = Object.keys(delivered);
    for (const forbidden of ['account_id', 'scan_id', 'id', 'state', 'evidence_ids']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    const serialised = JSON.stringify(delivered);
    expect(serialised).not.toContain('/api/v1/evidence/');
    expect(serialised).not.toContain('object_key');
  });

  it('is marked not to be indexed', async () => {
    const response = await read(issued.token);
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('mutates nothing a later reader could notice', async () => {
    // M3: "GET tokens never mutate data." Reading it ten times leaves the grant exactly as it
    // was — no counter, no last-accessed, no state change.
    const before = await h.json<ReportGrants>(
      await h.request(`/api/v1/reports/${reportId}/grants`),
    );
    for (let i = 0; i < 10; i += 1) expect((await read(issued.token)).status).toBe(200);
    const after = await h.json<ReportGrants>(await h.request(`/api/v1/reports/${reportId}/grants`));
    expect(after).toEqual(before);
  });

  it('answers the same way for every kind of bad link', async () => {
    // Expired, revoked, mistyped, another workspace's, never issued: one answer, because the
    // differences are exactly what somebody probing with guessed tokens wants to learn.
    const bodies = new Set<string>();
    for (const token of [
      'a'.repeat(43),
      'not-a-token',
      `${issued.token}x`,
      issued.token.slice(0, -1),
    ]) {
      const response = await read(token);
      expect(response.status, token).toBe(404);
      bodies.add((await h.json<{ detail: string }>(response)).detail);
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toBe('This link is not valid. It may have expired, or been withdrawn.');
  });
});

/**
 * The page a customer actually opens.
 *
 * Two things are asserted that the JSON route cannot show: that the content is escaped, and
 * that the invalid-link page is the *same page* for every reason a link might not work.
 */
describe('the customer-facing page', () => {
  async function pageFor(token: string): Promise<Response> {
    return await h.app.fetch(new Request(`http://127.0.0.1:4173/r/${token}`));
  }

  it('renders the report, with its limits attached to its claims', async () => {
    const live = await h.json<IssuedReportGrant>(
      await h.request(`/api/v1/reports/${reportId}/grants`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({
          recipient_note: 'page rendering case',
          recipient_ref: 'page@example.com',
        }),
      }),
    );
    // The link an operator hands over points at the page, not at the JSON.
    expect(live.url).toContain('/r/');

    const response = await pageFor(live.token);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();

    expect(html).toContain('What we inspected');
    expect(html).toContain('What this does not establish');
    expect(html).toContain('What we did not do');
    // No script anywhere, and a CSP that would refuse one if there were.
    expect(html).not.toMatch(/<script/i);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Style is allowed by hash, not by unsafe-inline.
    expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain('unsafe-inline');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');

    // Nothing that reaches another object.
    expect(html).not.toContain('/api/v1/');
    expect(html).not.toContain(reportId);
  });

  it('shows one page for every reason a link might not work', async () => {
    const pages = new Set<string>();
    for (const token of ['a'.repeat(43), 'not-a-token', 'b'.repeat(64)]) {
      const response = await pageFor(token);
      expect(response.status, token).toBe(404);
      expect(response.headers.get('content-type')).toContain('text/html');
      pages.add(await response.text());
    }
    expect(pages.size).toBe(1);
    const page = [...pages][0]!;
    expect(page).toContain('This link is not available');
    // It must not say which of the reasons applied, nor offer a way to probe for more.
    expect(page).not.toMatch(/revoked|expired on|does not exist|no such/i);
    expect(page).not.toMatch(/<form/i);
  });

  it('escapes what it renders', async () => {
    // The report body is written by this system, but a scope summary reaches it from an
    // operator's keyboard and a target URL from a stranger's form. Neither is markup.
    const html = await (
      await pageFor(
        (
          await h.json<IssuedReportGrant>(
            await h.request(`/api/v1/reports/${reportId}/grants`, {
              method: 'POST',
              subject: 'reviewer@fixture.test',
              body: JSON.stringify({
                recipient_note: 'escaping case',
                recipient_ref: 'escape@example.com',
              }),
            }),
          )
        ).token,
      )
    ).text();
    // The fixture URL contains no markup, so the assertion is structural: every `<` in the
    // document opens a tag this file wrote, and none came from data.
    const tags = html.match(/<[a-zA-Z/!]/g) ?? [];
    expect(tags.length).toBeGreaterThan(20);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });
});

describe('expiry', () => {
  it('is enforced by the database, not by the application clock', async () => {
    // The identity role's policy compares against the database's own `now()`, so an expired
    // grant is invisible to the lookup before any application code could decide otherwise.
    // That is why this test moves the row's expiry rather than the process's clock: moving
    // the clock would test a check that is deliberately not where the enforcement lives.
    expect((await read(issued.token)).status).toBe(200);

    await withMigrationClient(async (client) => {
      await client.query(`SELECT set_config('oe.tenant_id', $1, false)`, [LOCAL_FIXTURE.tenantA]);
      await client.query(
        `UPDATE oe.report_grants SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [issued.grant.id],
      );
    });

    const expired = await read(issued.token);
    expect(expired.status).toBe(404);
    expect((await h.json<{ detail: string }>(expired)).detail).toBe(
      'This link is not valid. It may have expired, or been withdrawn.',
    );
  });

  it('shows an operator that it expired, rather than pretending it never existed', async () => {
    const listed = await h.json<ReportGrants>(
      await h.request(`/api/v1/reports/${reportId}/grants`),
    );
    const grant = listed.items.find((item) => item.id === issued.grant.id)!;
    // Derived from the expiry rather than swept: the list is true without anything having run.
    expect(grant.state).toBe('expired');
  });

  it('can be reissued after expiry, as a new grant with a new token', async () => {
    const reissued = await h.json<IssuedReportGrant>(
      await h.request(`/api/v1/reports/${reportId}/grants`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({
          recipient_note: 'reissued after expiry',
          recipient_ref: 'requester@example.com',
        }),
      }),
    );
    expect(reissued.token).not.toBe(issued.token);
    expect((await read(reissued.token)).status).toBe(200);
    // The expired one stays expired. Reissuing does not revive a link somebody may have lost.
    expect((await read(issued.token)).status).toBe(404);
    issued = reissued;
  });
});

describe('revocation', () => {
  it('takes effect on the next read', async () => {
    expect((await read(issued.token)).status).toBe(200);

    const response = await h.request(`/api/v1/report-grants/${issued.grant.id}/revoke`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({ reason: 'Sent to the wrong address.' }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const revoked = await h.json<ReportGrant>(response);
    expect(revoked.state).toBe('revoked');
    expect(revoked.revoke_reason).toBe('Sent to the wrong address.');

    // There is no session to expire, so "immediately" means immediately.
    expect((await read(issued.token)).status).toBe(404);
  });

  it('keeps the record rather than deleting it', async () => {
    const listed = await h.json<ReportGrants>(
      await h.request(`/api/v1/reports/${reportId}/grants`),
    );
    const grant = listed.items.find((item) => item.id === issued.grant.id);
    expect(grant?.state).toBe('revoked');
    expect(grant?.revoked_at).not.toBeNull();
  });

  it('refuses to revoke the same grant twice', async () => {
    const response = await h.request(`/api/v1/report-grants/${issued.grant.id}/revoke`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({ reason: 'Second attempt.' }),
    });
    expect(response.status).toBe(404);
  });

  it('refuses a revoke from another workspace', async () => {
    const response = await h.request(`/api/v1/report-grants/${issued.grant.id}/revoke`, {
      method: 'POST',
      subject: 'other-owner@fixture.test',
      body: JSON.stringify({ reason: 'Not mine to withdraw.' }),
    });
    expect(response.status).toBe(404);
  });
});

describe('version binding', () => {
  it('stops serving when the report moves past the version the link was issued for', async () => {
    const live = await h.json<IssuedReportGrant>(
      await h.request(`/api/v1/reports/${reportId}/grants`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({
          recipient_note: 'version binding case',
          recipient_ref: 'version@example.com',
        }),
      }),
    );
    expect((await read(live.token)).status).toBe(200);

    const current = await h.json<Report>(await h.request(`/api/v1/reports/${reportId}`));
    const revoke = await h.request(`/api/v1/reports/${reportId}/revoke`, {
      method: 'POST',
      subject: 'reviewer@fixture.test',
      body: JSON.stringify({ expected_version: current.version }),
    });
    expect(revoke.status, await revoke.clone().text()).toBe(200);

    // The document somebody was given is no longer the document that exists. Serving the new
    // one would be a silent substitution; serving nothing is the honest answer.
    expect((await read(live.token)).status).toBe(404);
  });
});

/**
 * A German report, end to end.
 *
 * The frame is this system's own words and is translated. A confirmed finding is not: it is
 * the exact text a reviewer put their name to, and the document says so rather than mixing
 * languages silently or inventing a translation nobody checked.
 */
describe('a report in German', () => {
  it('writes its frame in German and says why the findings are not', async () => {
    const scan = await h.json<Scan>(
      await h.request(
        `/api/v1/scans/${
          (
            await h.json<Scan>(
              await h.request('/api/v1/scans', {
                method: 'POST',
                body: JSON.stringify(scanRequest()),
              }),
            )
          ).id
        }`,
      ),
    );
    await h.drain();
    const refreshed = await h.json<Scan>(await h.request(`/api/v1/scans/${scan.id}`));
    const findingId = refreshed.finding_ids[0]!;
    const finding = await h.json<Finding>(
      await h.request(`/api/v1/findings/${findingId}/review`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({
          expected_version: 1,
          decision: 'confirm',
          reason: 'Both recorded checks returned 404 for the linked size guide.',
          acknowledged_limitations: true,
        }),
      }),
    );

    const german = await h.json<Report>(
      await h.request('/api/v1/reports', {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({
          account_id: refreshed.account_id,
          scan_id: refreshed.id,
          finding_versions: [{ finding_id: finding.id, version: finding.version }],
          language: 'de',
          scope_summary:
            'Wir haben eine Produktseite und die daraus verlinkte Informationsseite geprüft.',
        }),
      }),
    );
    expect(german.language).toBe('de');
    expect(german.limitations.join(' ')).toContain('Umsatz wurde nicht gemessen');
    expect(german.findings_language_note).toContain('nicht übersetzt');

    for (const step of ['approve', 'publish']) {
      const current = await h.json<Report>(await h.request(`/api/v1/reports/${german.id}`));
      const response = await h.request(`/api/v1/reports/${german.id}/${step}`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({ expected_version: current.version }),
      });
      expect(response.status, `${step}: ${await response.clone().text()}`).toBe(200);
    }

    const issued = await h.json<IssuedReportGrant>(
      await h.request(`/api/v1/reports/${german.id}/grants`, {
        method: 'POST',
        subject: 'reviewer@fixture.test',
        body: JSON.stringify({
          recipient_note: 'German report case',
          recipient_ref: 'deutsch@example.com',
        }),
      }),
    );

    const page = await h.app.fetch(new Request(`http://127.0.0.1:4173/r/${issued.token}`));
    expect(page.status).toBe(200);
    const html = await page.text();

    expect(html).toContain('lang="de"');
    expect(html).toContain('Was wir geprüft haben');
    expect(html).toContain('Was daraus nicht folgt');
    expect(html).toContain('Was wir nicht getan haben');
    // The limitations render in German, including the one a careless translation drops.
    expect(html).toContain('Umsatz wurde nicht gemessen');
    expect(html).toContain('An der geprüften Website wurde nichts verändert');
    // And no English heading leaked through.
    expect(html).not.toContain('What we inspected');
    expect(html).not.toContain('What this does not establish');

    // The finding itself is the reviewer's English text, presented under a note that says so.
    expect(html).toContain('nicht übersetzt');
    expect(html).toContain('404');
  });

  it('serves the invalid-link page in German when asked for one', async () => {
    // Nothing identifies a reader, so a bad token cannot know which language to answer in;
    // English is the default and the query is how a venture site asks for the other.
    const bad = 'a'.repeat(43);
    const english = await h.app.fetch(new Request(`http://127.0.0.1:4173/r/${bad}`));
    expect(await english.text()).toContain('This link is not available');

    const german = await h.app.fetch(new Request(`http://127.0.0.1:4173/r/${bad}?lang=de`));
    const html = await german.text();
    expect(german.status).toBe(404);
    expect(html).toContain('Dieser Link ist nicht verfügbar');
    // It still says nothing about whether the report existed.
    expect(html).not.toMatch(/widerrufen von|abgelaufen am|kein solcher/i);
  });
});
