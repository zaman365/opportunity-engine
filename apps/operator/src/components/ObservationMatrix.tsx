import type { Evidence } from '@oe/contracts';

/**
 * The signature object of this interface.
 *
 * Neither implemented detector asserts anything from a single observation: their whole
 * evidentiary weight is that two independent, comparable, complete checks agreed. Prose can
 * state that; a grid shows it. Rows are the things that were inspected, columns are the clean
 * sessions, and each cell is one recorded response a reviewer can open.
 *
 * A missing cell is drawn as missing rather than omitted, so an incomplete sample reads as
 * incomplete instead of looking like a smaller but complete one.
 */

export type MatrixRole = 'source_page' | 'link_destination' | 'product_image';

export interface MatrixCell {
  evidence: Evidence | null;
  reference: string;
  role: MatrixRole;
  session: number;
}

export interface MatrixRow {
  key: string;
  role: MatrixRole;
  label: string;
  detail: string | null;
  url: string;
  cells: MatrixCell[];
}

export interface MatrixModel {
  sessions: number[];
  rows: MatrixRow[];
  agreement: { text: string; complete: boolean };
}

/**
 * Build the grid from the evidence a scan actually recorded.
 *
 * Rows come from the evidence itself rather than a fixed list, because what a scan inspects
 * depends on its detectors: MF-LINK-01 adds a linked page, MF-ASSET-01 adds one row per
 * referenced image. `focusUrl` is the thing the selected finding rests on, so its row leads
 * and the agreement line describes it.
 */
export function buildMatrix(
  evidence: Evidence[],
  sourceUrl: string,
  focusUrl?: string | null,
): MatrixModel {
  const sessions = [...new Set(evidence.map(sessionOf))].sort((a, b) => a - b);
  // Always show two columns: a rule needs two independent checks, so a single captured
  // session must read as "one of two", not as a complete pair.
  while (sessions.length < 2) sessions.push(sessions.length + 1);

  const byUrl = new Map<string, Evidence[]>();
  for (const item of evidence) {
    byUrl.set(item.source_url, [...(byUrl.get(item.source_url) ?? []), item]);
  }

  const descriptors = [...byUrl.entries()]
    .map(([url, items]) => ({ url, items, ...describeRow(url, items, sourceUrl) }))
    .sort((a, b) => {
      // The focused observation first, then the page, its links, and its images.
      const focused = Number(sameUrl(b.url, focusUrl)) - Number(sameUrl(a.url, focusUrl));
      if (focused !== 0) return focused;
      if (a.order !== b.order) return a.order - b.order;
      return a.url.localeCompare(b.url);
    });

  const rows: MatrixRow[] = descriptors.map((descriptor, rowIndex) => ({
    key: descriptor.url,
    role: descriptor.role,
    label: descriptor.label,
    detail: descriptor.detail,
    url: descriptor.url,
    cells: sessions.map((session) => ({
      evidence: descriptor.items.find((item) => sessionOf(item) === session) ?? null,
      reference: `E${rowIndex + 1}.${session}`,
      role: descriptor.role,
      session,
    })),
  }));

  // The agreement line describes the row the claim rests on: the focused observation when
  // there is one, otherwise the first row that is not the page itself.
  const subject = rows.find((row) => sameUrl(row.url, focusUrl)) ?? rows[1] ?? rows[0] ?? null;
  const cells = (subject?.cells ?? []).map((cell) => cell.evidence).filter(isEvidence);
  return { sessions, rows, agreement: describeAgreement(cells, subject?.role ?? 'source_page') };
}

/** What a row is, how it is labelled, and where it belongs in the reading order. */
function describeRow(
  url: string,
  items: Evidence[],
  sourceUrl: string,
): { role: MatrixRole; label: string; detail: string | null; order: number } {
  if (sameUrl(url, sourceUrl)) {
    return { role: 'source_page', label: 'Inspected page', detail: null, order: 0 };
  }
  if ((items[0]?.conditions.session_id ?? '').includes(':link_destination:')) {
    return { role: 'link_destination', label: 'Linked information page', detail: null, order: 1 };
  }
  // The classification is the whole reason an image failure is or is not a claim, so the row
  // states it rather than leaving a reviewer to infer it.
  const role = imageRole(items[0]);
  return {
    role: 'product_image',
    label: role === 'product' ? 'Product image' : 'Image on the page',
    detail: role === 'product' ? null : `classified ${role}`,
    order: 2,
  };
}

function imageRole(evidence: Evidence | undefined): string {
  const role = (evidence?.observation as { role?: unknown } | undefined)?.role;
  return typeof role === 'string' ? role : 'unknown';
}

function isEvidence(value: Evidence | null): value is Evidence {
  return value !== null;
}

function sessionOf(evidence: Evidence): number {
  // The capture adapter encodes the clean-session ordinal at the end of the session id.
  const match = /:(\d+)$/.exec(evidence.conditions.session_id);
  return match ? Number(match[1]) : 1;
}

function sameUrl(a: string, b: string | null | undefined): boolean {
  if (!b) return false;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

function describeAgreement(
  cells: Evidence[],
  role: MatrixRole,
): { text: string; complete: boolean } {
  const subject = role === 'product_image' ? 'image' : 'page';
  if (cells.length === 0) {
    return {
      text:
        role === 'product_image'
          ? 'No image observation was recorded.'
          : 'No linked page was opened.',
      complete: false,
    };
  }
  if (cells.length < 2) {
    return {
      text: `Only one check of this ${subject} completed. Two independent checks are required.`,
      complete: false,
    };
  }
  if (cells.some((cell) => !cell.complete)) {
    return {
      text: 'A check did not complete, so the two results are not comparable.',
      complete: false,
    };
  }
  if (new Set(cells.map((cell) => cell.http_status)).size > 1) {
    return {
      text: 'The checks returned different statuses, so the result is unconfirmed.',
      complete: false,
    };
  }
  const contexts = new Set(
    cells.map((cell) => `${cell.conditions.variant ?? '-'}|${cell.conditions.viewport_width}`),
  );
  if (contexts.size > 1) {
    return {
      text: 'The checks ran under different page conditions, so they are not comparable.',
      complete: false,
    };
  }
  if (role === 'product_image') {
    const painted = cells.every((cell) => rendered(cell));
    const status = cells[0]!.http_status;
    return painted
      ? { text: `Both independent checks loaded this image (HTTP ${status}).`, complete: true }
      : {
          text: `Neither independent check rendered this image; its request returned ${status ?? 'no response'}.`,
          complete: true,
        };
  }
  return {
    text: `Both independent checks returned ${cells[0]!.http_status} under the same recorded conditions.`,
    complete: true,
  };
}

function rendered(evidence: Evidence): boolean {
  return (evidence.observation as { rendered?: unknown } | undefined)?.rendered === true;
}

/**
 * A cell's verdict drives its colour and glyph.
 *
 * For an image, a 200 that never painted is not a success: the cell reports what the reviewer
 * would see on the page, not what the network said.
 */
function verdictOf(cell: MatrixCell): 'ok' | 'failure' | 'unknown' | 'missing' {
  if (!cell.evidence) return 'missing';
  const status = cell.evidence.http_status;
  if (!cell.evidence.complete || status === null) return 'unknown';
  if (cell.role === 'product_image') {
    if (rendered(cell.evidence)) return 'ok';
    return status >= 400 || status === 200 ? 'failure' : 'unknown';
  }
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 410) return 'failure';
  return 'unknown';
}

/** What a cell shows beneath its status, in the reviewer's terms. */
function cellNote(cell: MatrixCell): string {
  const evidence = cell.evidence!;
  if (!evidence.complete) return 'incomplete capture';
  if (cell.role !== 'product_image') return 'complete capture';
  return rendered(evidence) ? 'rendered on the page' : 'did not render';
}

export function ObservationMatrix({
  model,
  selectedEvidenceId,
  onSelect,
}: {
  model: MatrixModel;
  selectedEvidenceId: string | null;
  onSelect: (evidence: Evidence, reference: string) => void;
}) {
  return (
    <div className="matrix">
      <table>
        <caption>Recorded observations · one cell per inspected item and clean session</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Inspected item</span>
            </th>
            {model.sessions.map((session) => (
              <th key={session} scope="col">
                Session {session}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                {row.label}
                {row.detail ? <span style={rowDetailStyle}>{row.detail}</span> : null}
                <span style={rowUrlStyle}>{shortPath(row.url)}</span>
              </th>
              {row.cells.map((cell) => {
                if (!cell.evidence) {
                  return (
                    <td key={cell.reference}>
                      <div className="cell empty">
                        <span className="ref">{cell.reference}</span>
                        <span className="status" aria-hidden="true">
                          —
                        </span>
                        <span className="note">Not captured</span>
                      </div>
                    </td>
                  );
                }
                return (
                  <td key={cell.reference}>
                    <button
                      type="button"
                      className="cell"
                      data-verdict={verdictOf(cell)}
                      aria-pressed={cell.evidence.id === selectedEvidenceId}
                      onClick={() => onSelect(cell.evidence!, cell.reference)}
                    >
                      <span className="ref">{cell.reference}</span>
                      <span className="status">{cell.evidence.http_status ?? 'no response'}</span>
                      <span className="note">{cellNote(cell)}</span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="agreement">
        <span aria-hidden="true">{model.agreement.complete ? '=' : '≠'}</span>
        {model.agreement.text}
      </p>
    </div>
  );
}

const rowDetailStyle: React.CSSProperties = {
  display: 'block',
  font: 'var(--text-micro)/1.4 var(--font-ui)',
  color: 'var(--ink-muted)',
  fontWeight: 400,
};

const rowUrlStyle: React.CSSProperties = {
  display: 'block',
  font: 'var(--text-micro)/1.4 var(--font-mono)',
  color: 'var(--ink-muted)',
  maxWidth: 200,
  overflowWrap: 'anywhere',
  fontWeight: 400,
};

function shortPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}
