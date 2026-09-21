import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Report, Session } from '@oe/contracts';
import { ApiError, NetworkError, command, newIdempotencyKey } from '../api/client.ts';
import { useResource } from '../api/hooks.ts';
import { Chip, ErrorPanel, Loading, Notice, Timestamp } from '../components/primitives.tsx';

interface ReportBody {
  title: string;
  scope_summary: string;
  as_of: string;
  inspected: {
    target_url: string;
    expected_unique_pages: number;
    captured_unique_pages: number;
    partial_reasons: string[];
  };
  confirmed_findings: {
    finding_id: string;
    version: number;
    claim: string;
    scope: string;
    limitations: string[];
    detector_id: string;
    detector_version: string;
    observed_conditions: {
      evidence_id: string;
      captured_at: string;
      http_status: number | null;
      final_url: string;
      session_id: string;
      viewport: string;
      locale: string;
      variant: string | null;
      consent_state: string;
      browser_version: string;
    }[];
  }[];
  no_supported_defect: boolean;
  exclusions: string[];
  limitations: string[];
}

type ReportPayload = Report & { body: ReportBody | null; body_sha256: string | null };

/** The reader's own timezone, named once rather than repeated on every row. */
function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'your local timezone';
  } catch {
    return 'your local timezone';
  }
}

/**
 * The protected report.
 *
 * UI_SPEC.md: "Do not render a dashboard as a customer report. Use an editorial assessment:
 * title/scope → strongest reviewed facts → evidence references → recommendations with
 * exclusions → next step."
 *
 * The body rendered here is the immutable snapshot the server stored and hashed. Nothing on
 * this page re-derives a claim from live rows.
 */
export function ReportRoute({ session }: { session: Session }) {
  const { id } = useParams<{ id: string }>();
  const resource = useResource<ReportPayload>(id ? `/reports/${id}` : null);

  if (resource.status === 'loading') return <Loading label="Loading the report" lines={6} />;
  if (resource.status === 'error') return <ErrorPanel error={resource.error} onRetry={resource.reload} />;

  const report = resource.data;

  if (report.state === 'revoked' || !report.body) {
    return (
      <div className="report">
        <h1>This report is no longer available</h1>
        <p className="asof">
          It was revoked{report.published_at ? ' after publication' : ''}. No content is shown.
        </p>
      </div>
    );
  }

  const body = report.body;

  return (
    <>
      <div className="pagehead no-print">
        <div>
          <h1>Report</h1>
          <p>
            A protected internal version. Nothing here is sent to a customer: external
            delivery is a separate, later permission.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip tone={report.state === 'published' ? 'confirmed' : 'attention'}>{report.state}</Chip>
          <ReportActions report={report} session={session} onChanged={resource.reload} />
        </div>
      </div>

      <article className="report">
        <h1>{body.title}</h1>
        <p className="asof">
          As of <Timestamp value={body.as_of} /> · version {report.version} · audience{' '}
          {report.audience.replaceAll('_', ' ')}
        </p>
        {report.body_sha256 ? (
          <p className="asof" style={{ marginTop: 'var(--s1)' }}>
            Body hash {report.body_sha256.slice(0, 16)}… — this version cannot change once
            published.
          </p>
        ) : null}

        <section>
          <h2>What we inspected</h2>
          <p>{body.scope_summary}</p>
          <p style={{ marginTop: 'var(--s3)', color: 'var(--ink-secondary)' }}>
            {body.inspected.captured_unique_pages} of {body.inspected.expected_unique_pages} pages
            were captured, starting from <code>{body.inspected.target_url}</code>.
          </p>
          {body.inspected.partial_reasons.length > 0 ? (
            <ul style={{ marginTop: 'var(--s3)', color: 'var(--ink-secondary)' }}>
              {body.inspected.partial_reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </section>

        <section>
          <h2>What we established</h2>
          {body.no_supported_defect ? (
            <p style={{ fontSize: 'var(--text-section)', fontWeight: 560 }}>
              No supported defect was found in the inspected pages.
            </p>
          ) : (
            body.confirmed_findings.map((finding) => (
              <div key={finding.finding_id} className="finding" style={{ marginBottom: 'var(--s8)' }}>
                <p>{finding.claim}</p>
                <p style={{ marginTop: 'var(--s3)', color: 'var(--ink-secondary)' }}>
                  Scope: {finding.scope}
                </p>
                <table>
                  <caption className="visually-hidden">
                    Recorded conditions for each observation supporting this finding
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Checked</th>
                      <th scope="col">Response</th>
                      <th scope="col">Session</th>
                      <th scope="col">Conditions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {finding.observed_conditions.map((observation) => (
                      <tr key={observation.evidence_id}>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <Timestamp value={observation.captured_at} compact />
                        </td>
                        <td>{observation.http_status ?? 'no response'}</td>
                        <td>{observation.session_id.slice(-24)}</td>
                        <td>
                          {observation.viewport} · {observation.locale} ·{' '}
                          {observation.variant ?? 'no selected variant'} ·{' '}
                          {observation.consent_state}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ marginTop: 'var(--s3)', fontSize: 'var(--text-meta)', color: 'var(--ink-muted)' }}>
                  Detector {finding.detector_id} v{finding.detector_version}, finding version{' '}
                  {finding.version}. Times are shown in {localZone()}; the recorded values are
                  UTC.
                </p>
              </div>
            ))
          )}
        </section>

        <section>
          <h2>What this does not establish</h2>
          <ul style={{ margin: 0, paddingInlineStart: 'var(--s5)', color: 'var(--ink-secondary)' }}>
            {body.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </section>

        <section>
          <h2>Exclusions</h2>
          <ul style={{ margin: 0, paddingInlineStart: 'var(--s5)', color: 'var(--ink-secondary)' }}>
            {body.exclusions.map((exclusion) => (
              <li key={exclusion}>{exclusion}</li>
            ))}
          </ul>
        </section>

        <section>
          <h2>Next step</h2>
          <p>
            {body.no_supported_defect
              ? 'No repair is proposed from this sample. A wider inspection can be authorised separately.'
              : 'A scoped proposal can be requested for the specific link repair described above. Pricing and capacity are not set in this milestone.'}
          </p>
        </section>
      </article>
    </>
  );
}

function ReportActions({
  report,
  session,
  onChanged,
}: {
  report: Report;
  session: Session;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const canAct = session.role === 'reviewer' || session.role === 'owner';

  async function act(action: 'approve' | 'publish' | 'revoke') {
    setBusy(action);
    setError(null);
    try {
      await command(
        `/reports/${report.id}/${action}`,
        { expected_version: report.version },
        { idempotencyKey: newIdempotencyKey() },
      );
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError || caught instanceof NetworkError) setError(caught);
      else setError(new NetworkError('The action could not be completed.'));
    } finally {
      setBusy(null);
    }
  }

  const next =
    report.state === 'draft'
      ? ('approve' as const)
      : report.state === 'approved'
        ? ('publish' as const)
        : null;

  return (
    <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap', alignItems: 'center' }}>
      {next ? (
        <button
          type="button"
          className="btn"
          data-variant="primary"
          disabled={!canAct || busy !== null}
          onClick={() => act(next)}
          title={canAct ? undefined : 'Requires the reviewer role.'}
        >
          {busy === next ? 'Working…' : next === 'approve' ? 'Approve' : 'Publish version'}
        </button>
      ) : null}
      {report.state === 'published' ? (
        <button
          type="button"
          className="btn"
          disabled={!canAct || busy !== null}
          onClick={() => act('revoke')}
        >
          {busy === 'revoke' ? 'Revoking…' : 'Revoke access'}
        </button>
      ) : null}
      <button type="button" className="btn" onClick={() => window.print()}>
        Print
      </button>
      {error ? (
        <div style={{ flexBasis: '100%' }}>
          <ErrorPanel error={error} />
        </div>
      ) : null}
      {report.state === 'approved' ? (
        <Notice tone="attention" title="Approval does not send anything">
          <p style={{ fontSize: 'var(--text-meta)' }}>
            Publishing creates a protected internal version and re-checks every bound finding
            version first.
          </p>
        </Notice>
      ) : null}
    </div>
  );
}
