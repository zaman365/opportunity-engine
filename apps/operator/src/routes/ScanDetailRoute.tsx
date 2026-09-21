import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Evidence, Finding, Scan, Session } from '@oe/contracts';
import { ApiError, NetworkError, command, newIdempotencyKey } from '../api/client.ts';
import { usePolling, useResource } from '../api/hooks.ts';
import { BudgetSummary, CoverageSummary, ScanTimeline, scanTone } from '../components/panels.tsx';
import { Chip, ErrorPanel, Loading, Notice, Timestamp } from '../components/primitives.tsx';

interface Timeline {
  steps: { id: string; step_key: string; state: string; attempt: number; updated_at: string }[];
  evidence: Evidence[];
  findings: Finding[];
}

const ACTIVE = new Set(['queued', 'validating', 'capturing', 'analysing', 'cancel_requested']);

/**
 * Scan detail: what happened, and what is incomplete.
 *
 * UI_SPEC.md: "Real step state, completed denominator, partial/blocked reason, actual and
 * reserved costs." There is no progress percentage, because the runner does not know one.
 */
export function ScanDetailRoute({ session }: { session: Session }) {
  const { id } = useParams<{ id: string }>();
  const scan = useResource<Scan>(id ? `/scans/${id}` : null);
  const timeline = useResource<Timeline>(id ? `/scans/${id}/timeline` : null);

  const reload = useCallback(() => {
    scan.reload();
    timeline.reload();
  }, [scan, timeline]);

  usePolling(scan.data ? ACTIVE.has(scan.data.state) : false, reload);

  if (scan.status === 'loading') return <Loading label="Loading the scan record" lines={5} />;
  if (scan.status === 'error') return <ErrorPanel error={scan.error} onRetry={scan.reload} />;

  const record = scan.data;
  const tone = scanTone(record.state);
  const canCancel =
    (session.role !== 'viewer') && ACTIVE.has(record.state) && record.state !== 'cancel_requested';

  return (
    <>
      <div className="pagehead">
        <div>
          <p style={{ font: 'var(--text-meta)/1.5 var(--font-mono)', color: 'var(--ink-muted)' }}>
            <Link to="/scans">Scans</Link> / {record.id.slice(0, 8)}
          </p>
          <h1>Scan record</h1>
          <p style={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>{record.target_url}</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip tone={tone.tone}>{tone.label}</Chip>
          {canCancel ? <CancelButton scan={record} onCancelled={reload} /> : null}
        </div>
      </div>

      {record.blocked_reason ? (
        <Notice tone="blocked" title="This scan did not complete">
          <p>{record.blocked_reason}</p>
          <p style={{ marginTop: 'var(--s2)' }}>
            No finding was produced. A blocked inspection is not evidence that the page is
            healthy.
          </p>
        </Notice>
      ) : null}

      {record.state === 'partial' ? (
        <Notice tone="attention" title="Partial sample">
          <p>
            {record.coverage.captured_unique_pages} of {record.coverage.expected_unique_pages}{' '}
            pages were captured. A finding can still be reviewed if its own required evidence
            is complete, and the report discloses the sample.
          </p>
        </Notice>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 'var(--s5)',
          marginTop: 'var(--s5)',
        }}
      >
        <div className="panel">
          <CoverageSummary scan={record} />
        </div>
        <div className="panel">
          <BudgetSummary scan={record} />
        </div>
        <div className="panel">
          <h2 style={{ fontSize: 'var(--text-section)' }}>State</h2>
          <dl style={{ margin: 0, display: 'grid', gap: 'var(--s3)', fontSize: 'var(--text-meta)' }}>
            <div>
              <dt style={{ color: 'var(--ink-muted)' }}>Version</dt>
              <dd style={{ margin: 0, fontFamily: 'var(--font-mono)' }}>{record.version}</dd>
            </div>
            <div>
              <dt style={{ color: 'var(--ink-muted)' }}>Created</dt>
              <dd style={{ margin: 0 }}>
                <Timestamp value={record.created_at} />
              </dd>
            </div>
            <div>
              <dt style={{ color: 'var(--ink-muted)' }}>Updated</dt>
              <dd style={{ margin: 0 }}>
                <Timestamp value={record.updated_at} />
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 'var(--s5)' }}>
        <h2>Recorded steps</h2>
        {timeline.status === 'ready' ? (
          <ScanTimeline steps={timeline.data.steps} />
        ) : timeline.status === 'error' ? (
          <ErrorPanel error={timeline.error} onRetry={timeline.reload} />
        ) : (
          <Loading label="Loading recorded steps" lines={3} />
        )}
      </div>

      {timeline.status === 'ready' && timeline.data.findings.length > 0 ? (
        <div className="panel">
          <h2>Findings from this scan</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {timeline.data.findings.map((finding) => (
              <li
                key={finding.id}
                style={{ padding: 'var(--s3) 0', borderBottom: '1px solid var(--rule)' }}
              >
                <p style={{ fontWeight: 560 }}>{finding.claim}</p>
                <p style={{ marginTop: 'var(--s1)', fontSize: 'var(--text-meta)', color: 'var(--ink-secondary)' }}>
                  {finding.detector_id} v{finding.detector_version} · state {finding.state} · version{' '}
                  {finding.version}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function CancelButton({ scan, onCancelled }: { scan: Scan; onCancelled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await command(
        `/scans/${scan.id}/cancel`,
        { expected_version: scan.version },
        { idempotencyKey: newIdempotencyKey() },
      );
      onCancelled();
      setConfirming(false);
    } catch (caught) {
      if (caught instanceof ApiError || caught instanceof NetworkError) setError(caught);
      else setError(new NetworkError('The cancellation could not be sent.'));
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <>
        <button type="button" className="btn" onClick={() => setConfirming(true)}>
          Stop new work
        </button>
        {error ? <ErrorPanel error={error} /> : null}
      </>
    );
  }

  return (
    <div className="notice" data-tone="attention" style={{ maxWidth: 420 }}>
      <h3>Stop new work on this scan?</h3>
      <p style={{ fontSize: 'var(--text-meta)' }}>
        No further pages will be requested. Provider cost already incurred stays recorded and
        may still settle.
      </p>
      <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
        <button type="button" className="btn" data-variant="primary" onClick={cancel} disabled={busy}>
          {busy ? 'Stopping…' : 'Stop new work'}
        </button>
        <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>
          Keep running
        </button>
      </div>
      {error ? <ErrorPanel error={error} /> : null}
    </div>
  );
}
