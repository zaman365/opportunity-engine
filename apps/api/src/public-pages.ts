import { createHash } from 'node:crypto';
import type { ReportBody } from './services/report.ts';

/**
 * The two pages a member of the public ever sees.
 *
 * Server-rendered, with no script and no stylesheet of their own. That is not minimalism for
 * its own sake: a page served to somebody outside the workspace, carrying claims a reviewer
 * put their name to, has the narrowest possible attack surface when there is nothing on it to
 * execute. The CSP each page carries forbids everything except its own inline style block, and
 * `escape` below is applied to every interpolated value without exception.
 *
 * They are plain HTML rather than part of the operator bundle for a second reason: the
 * operator app sits behind Cloudflare Access in production. A customer must never need to get
 * past Access to read their own report.
 */

/** Every interpolation goes through this. There is no "trusted" value on these pages. */
function escape(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * No external font, no external stylesheet, no image.
 *
 * Every byte of this page comes from this origin, so the CSP can forbid everything else
 * outright and a reader's request for it tells nobody else that they read it.
 */
const STYLE = `
  :root { color-scheme: light; --ink:#16191d; --ink-2:#4a5158; --rule:#dfe4e9; --paper:#fbfcfd; }
  * { box-sizing: border-box; }
  body { margin:0; padding:clamp(1.5rem,4vw,4rem) 1rem; background:var(--paper); color:var(--ink);
         font:16px/1.65 ui-serif, Georgia, "Times New Roman", serif; }
  main { max-width:44rem; margin:0 auto; }
  h1 { font-size:1.75rem; line-height:1.25; margin:0 0 .25rem; }
  h2 { font-size:1.05rem; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-2);
       font-family:ui-monospace, SFMono-Regular, Menlo, monospace; margin:2.5rem 0 .75rem; }
  h3 { font-size:1.1rem; margin:1.5rem 0 .4rem; }
  p, li { color:var(--ink); }
  .meta { font:0.85rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--ink-2);
          margin:0 0 2rem; }
  .card { border:1px solid var(--rule); border-radius:6px; padding:1.25rem; margin:1rem 0; }
  .limits { background:#fff; border-left:3px solid var(--rule); padding:.75rem 1rem; margin:1rem 0; }
  .limits li { color:var(--ink-2); font-size:.95rem; }
  footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--rule);
           font:0.85rem/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--ink-2); }
  code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.9em; word-break:break-all; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/**
 * The invalid-link page.
 *
 * One page for expired, revoked, mistyped, another workspace's, and never issued. It says
 * nothing about whether a report exists, who it belongs to, or why the link stopped working —
 * a page that explained would tell whoever holds a guessed link that they guessed correctly
 * once. It also does not offer a "request a new link" form, because that would be a way to
 * probe addresses.
 */
export function invalidLinkPage(): string {
  return page(
    'This link is not available',
    `<h1>This link is not available</h1>
     <p>It may have expired, or it may have been withdrawn.</p>
     <p>If you were expecting to read something here, reply to whoever sent you the link and
        ask them to issue a new one.</p>`,
  );
}

export interface DeliveredPageInput {
  body: ReportBody;
  reportVersion: number;
  publishedAt: string | null;
  expiresAt: string;
}

function isoDate(value: string | null): string {
  if (value === null) return 'not recorded';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'not recorded' : parsed.toISOString().slice(0, 10);
}

/**
 * The report, as the person it is about reads it.
 *
 * The same content the operator sees, in the same order, with the same limitations attached to
 * the same claims. It is deliberately not a summary or a sales document: a reader who was told
 * what was checked, what was found, and what none of it establishes can judge the work. One
 * who was told only the conclusion cannot.
 */
export function deliveredReportPage(input: DeliveredPageInput): string {
  const { body } = input;

  const findings = body.confirmed_findings
    .map(
      (finding) => `
      <div class="card">
        <h3>${escape(finding.claim)}</h3>
        <p class="meta">${escape(finding.detector_id)} v${escape(finding.detector_version)} ·
          evidence grade ${escape(finding.evidence_grade ?? 'not graded')} ·
          ${finding.observed_conditions.length} recorded observation${
            finding.observed_conditions.length === 1 ? '' : 's'
          }</p>
        <p>${escape(finding.scope)}</p>
        <div class="limits">
          <p class="meta" style="margin:0 0 .35rem">What this does not establish</p>
          <ul>${finding.limitations.map((limit) => `<li>${escape(limit)}</li>`).join('')}</ul>
        </div>
      </div>`,
    )
    .join('');

  const noDefect = body.no_supported_defect
    ? `<div class="card">
         <h3>No supported defect in what we checked</h3>
         <p>The pages listed above were inspected and nothing met the bar for a supported
            finding. That is a result about this sample, not a statement about the whole
            site.</p>
       </div>`
    : '';

  return page(
    body.title,
    `<h1>${escape(body.title)}</h1>
     <p class="meta">As of ${escape(isoDate(body.as_of))} ·
        version ${escape(input.reportVersion)} ·
        this link expires ${escape(isoDate(input.expiresAt))}</p>

     <h2>What we inspected</h2>
     <p>${escape(body.scope_summary)}</p>
     <p class="meta">${escape(body.inspected.captured_unique_pages)} of
        ${escape(body.inspected.expected_unique_pages)} pages captured, starting from
        <code>${escape(body.inspected.target_url)}</code></p>
     ${
       body.inspected.partial_reasons.length > 0
         ? `<div class="limits"><ul>${body.inspected.partial_reasons
             .map((reason) => `<li>${escape(reason)}</li>`)
             .join('')}</ul></div>`
         : ''
     }

     <h2>What we found</h2>
     ${findings}${noDefect}

     <h2>What this does not establish</h2>
     <ul>${body.limitations.map((limit) => `<li>${escape(limit)}</li>`).join('')}</ul>

     <h2>What we did not do</h2>
     <ul>${body.exclusions.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>

     <footer>
       <p>This page is a fixed version of a reviewed assessment. It does not change after
          publication, and the link that opens it expires.</p>
     </footer>`,
  );
}

/**
 * The Content-Security-Policy both pages carry.
 *
 * Everything denied except the one inline style block this file writes, allowed by hash rather
 * than by `unsafe-inline`: a page carrying somebody else's data should not permit arbitrary
 * inline style, because that is half of what escaping is protecting against.
 *
 * The hash is computed from the same constant the markup embeds, so the two cannot drift.
 */
const STYLE_HASH = `sha256-${createHash('sha256').update(STYLE).digest('base64')}`;

export const PUBLIC_PAGE_CSP = [
  "default-src 'none'",
  `style-src '${STYLE_HASH}'`,
  "img-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');
