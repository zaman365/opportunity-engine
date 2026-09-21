import { Link } from 'react-router-dom';
import type { Scans } from '@oe/contracts';
import { useResource } from '../api/hooks.ts';
import {
  Chip,
  EmptyState,
  ErrorPanel,
  Loading,
  Money,
  Timestamp,
} from '../components/primitives.tsx';
import { scanTone } from '../components/panels.tsx';

/** Scan records: what ran, what it covered and what it cost. */
export function ScansRoute() {
  const resource = useResource<Scans>('/scans?limit=100');

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Scans</h1>
          <p>
            Each scan is one bounded inspection of an approved page. A completed scan means
            collection finished — not that a finding was reviewed.
          </p>
        </div>
        <Link className="btn" data-variant="primary" to="/scans/new">
          New scan
        </Link>
      </div>

      {resource.status === 'loading' ? <Loading label="Loading scans" lines={4} /> : null}
      {resource.status === 'error' ? (
        <ErrorPanel error={resource.error} onRetry={resource.reload} />
      ) : null}

      {resource.status === 'ready' && resource.data.items.length === 0 ? (
        <EmptyState
          kind="workspace"
          title="No scans yet"
          action={
            <Link className="btn" data-variant="primary" to="/scans/new">
              Create an approved scan
            </Link>
          }
        >
          Nothing has been inspected in this workspace.
        </EmptyState>
      ) : null}

      {resource.status === 'ready' && resource.data.items.length > 0 ? (
        <ul className="caselist">
          {resource.data.items.map((scan) => {
            const tone = scanTone(scan.state);
            return (
              <li key={scan.id} className="caserow">
                <span className="docket">{scan.id.slice(0, 8)}</span>
                <span className="title">
                  <Link to={`/scans/${scan.id}`}>{scan.target_url}</Link>
                  <span className="account">
                    {scan.coverage.captured_unique_pages} of {scan.coverage.expected_unique_pages}{' '}
                    pages captured
                    {scan.blocked_reason ? ` · ${scan.blocked_reason}` : ''}
                  </span>
                </span>
                <span>
                  <Chip tone={tone.tone}>{tone.label}</Chip>
                </span>
                <span className="score">
                  <b>
                    <Money
                      currency={scan.cost.settled.currency}
                      amountMicro={scan.cost.settled.amount_micro}
                    />
                  </b>
                  spent of{' '}
                  <Money
                    currency={scan.cost.cap.currency}
                    amountMicro={scan.cost.cap.amount_micro}
                  />
                </span>
                <span className="score">
                  <b>
                    {scan.finding_ids.length} finding{scan.finding_ids.length === 1 ? '' : 's'}
                  </b>
                  <Timestamp value={scan.updated_at} />
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
