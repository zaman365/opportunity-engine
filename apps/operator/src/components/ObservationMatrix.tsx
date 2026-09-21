import type { Evidence } from '@oe/contracts';

/**
 * The signature object of this interface.
 *
 * MF-LINK-01 asserts nothing from a single observation: its whole evidentiary weight is
 * that two independent, comparable, complete checks agreed. Prose can state that; a grid
 * shows it. Rows are the pages that were inspected, columns are the clean sessions, and
 * each cell is one recorded response a reviewer can open.
 *
 * A missing cell is drawn as missing rather than omitted, so an incomplete sample reads as
 * incomplete instead of looking like a smaller but complete one.
 */

export interface MatrixCell {
  evidence: Evidence | null;
  reference: string;
  role: 'source_page' | 'link_destination';
  session: number;
}

export interface MatrixModel {
  sessions: number[];
  rows: { role: 'source_page' | 'link_destination'; label: string; url: string | null; cells: MatrixCell[] }[];
  agreement: { text: string; complete: boolean };
}

/** Build the grid from the evidence a scan actually recorded. */
export function buildMatrix(evidence: Evidence[], sourceUrl: string): MatrixModel {
  const bySession = new Set<number>();
  for (const item of evidence) {
    bySession.add(sessionOf(item));
  }
  const sessions = [...bySession].sort((a, b) => a - b);
  // Always show two columns: the rule needs two independent checks, so a single captured
  // session must read as "one of two", not as a complete pair.
  while (sessions.length < 2) sessions.push(sessions.length + 1);

  const destinationUrl =
    evidence.find((e) => !sameUrl(e.source_url, sourceUrl))?.source_url ?? null;

  const rows = (
    [
      { role: 'source_page' as const, label: 'Inspected page', url: sourceUrl },
      { role: 'link_destination' as const, label: 'Linked information page', url: destinationUrl },
    ] satisfies { role: MatrixCell['role']; label: string; url: string | null }[]
  ).map((row, rowIndex) => ({
    ...row,
    cells: sessions.map((session) => {
      const match =
        row.url === null
          ? null
          : (evidence.find((e) => sameUrl(e.source_url, row.url!) && sessionOf(e) === session) ?? null);
      return {
        evidence: match,
        reference: `E${rowIndex + 1}.${session}`,
        role: row.role,
        session,
      } satisfies MatrixCell;
    }),
  }));

  const destinationCells = rows[1]!.cells.map((c) => c.evidence).filter(Boolean) as Evidence[];
  const agreement = describeAgreement(destinationCells);
  return { sessions, rows, agreement };
}

function sessionOf(evidence: Evidence): number {
  // The capture adapter encodes the clean-session ordinal at the end of the session id.
  const match = /:(\d+)$/.exec(evidence.conditions.session_id);
  return match ? Number(match[1]) : 1;
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

function describeAgreement(cells: Evidence[]): { text: string; complete: boolean } {
  if (cells.length === 0) {
    return { text: 'No linked information page was opened.', complete: false };
  }
  if (cells.length < 2) {
    return { text: 'Only one check completed. Two independent checks are required.', complete: false };
  }
  if (cells.some((c) => !c.complete)) {
    return { text: 'A check did not complete, so the two results are not comparable.', complete: false };
  }
  const statuses = new Set(cells.map((c) => c.http_status));
  if (statuses.size > 1) {
    return { text: 'The checks returned different statuses, so the result is unconfirmed.', complete: false };
  }
  const status = cells[0]!.http_status;
  const contexts = new Set(cells.map((c) => `${c.conditions.variant ?? '-'}|${c.conditions.viewport_width}`));
  if (contexts.size > 1) {
    return { text: 'The checks ran under different page conditions, so they are not comparable.', complete: false };
  }
  return {
    text: `Both independent checks returned ${status} under the same recorded conditions.`,
    complete: true,
  };
}

function verdictOf(cell: MatrixCell): 'ok' | 'failure' | 'unknown' | 'missing' {
  if (!cell.evidence) return 'missing';
  const status = cell.evidence.http_status;
  if (!cell.evidence.complete || status === null) return 'unknown';
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 410) return 'failure';
  return 'unknown';
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
        <caption>Recorded observations · one cell per page and clean session</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Page</span>
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
            <tr key={row.role}>
              <th scope="row">
                {row.label}
                {row.url ? (
                  <span
                    style={{
                      display: 'block',
                      font: 'var(--text-micro)/1.4 var(--font-mono)',
                      color: 'var(--ink-muted)',
                      maxWidth: 200,
                      overflowWrap: 'anywhere',
                      fontWeight: 400,
                    }}
                  >
                    {shortPath(row.url)}
                  </span>
                ) : null}
              </th>
              {row.cells.map((cell) => {
                const verdict = verdictOf(cell);
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
                const selected = cell.evidence.id === selectedEvidenceId;
                return (
                  <td key={cell.reference}>
                    <button
                      type="button"
                      className="cell"
                      data-verdict={verdict}
                      aria-pressed={selected}
                      onClick={() => onSelect(cell.evidence!, cell.reference)}
                    >
                      <span className="ref">{cell.reference}</span>
                      <span className="status">{cell.evidence.http_status ?? 'no response'}</span>
                      <span className="note">
                        {cell.evidence.complete ? 'complete capture' : 'incomplete capture'}
                      </span>
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

function shortPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}
