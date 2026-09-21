import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Evidence, Finding, OpportunityDetail, Scan, Session } from '@oe/contracts';
import { ApiError, NetworkError, command, newIdempotencyKey } from '../api/client.ts';
import { useResource } from '../api/hooks.ts';
import { buildMatrix, ObservationMatrix } from '../components/ObservationMatrix.tsx';
import { EvidenceStage } from '../components/EvidenceStage.tsx';
import { FindingNarrative, findingTone } from '../components/FindingNarrative.tsx';
import { ReviewSeam } from '../components/ReviewSeam.tsx';
import { CoverageSummary } from '../components/panels.tsx';
import { Chip, ErrorPanel, Loading, Notice, Timestamp } from '../components/primitives.tsx';
import { docketOf } from './QueueRoute.tsx';

/**
 * The case: one account, one observation, its evidence and the decision.
 *
 * This is the composition chosen in the D0 study (docs/design/DESIGN_LOG.md). The centre
 * column leads with the observation matrix, because the whole evidentiary weight of
 * MF-LINK-01 is that two independent checks agreed — a grid shows that, prose only claims
 * it. Selecting a cell loads its artifact below and highlights the matching reference in
 * the claim column, so evidence and assertion stay linked without navigation.
 */
export function CaseRoute({ session }: { session: Session }) {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const detail = useResource<OpportunityDetail>(id ? `/opportunities/${id}` : null);
  const [localFinding, setLocalFinding] = useState<Finding | null>(null);
  const [selected, setSelected] = useState<{ evidence: Evidence; reference: string } | null>(null);
  const [tab, setTab] = useState<'index' | 'evidence' | 'finding' | 'decision'>('evidence');

  // One opportunity groups every finding that shares a root cause, so a case can hold more
  // than one. Work needing a decision comes first, and a deep link pins a specific finding.
  const findings = useMemo(() => orderForReview(detail.data?.findings ?? []), [detail.data]);
  const requested = params.get('finding');
  const current =
    (requested ? findings.find((f) => f.id === requested) : undefined) ?? findings[0] ?? null;
  const finding = localFinding && localFinding.id === current?.id ? localFinding : current;
  const scanId = finding?.scan_id ?? null;
  const scan = useResource<Scan>(scanId ? `/scans/${scanId}` : null, [scanId]);
  // The opportunity payload carries only the evidence a finding cites. The matrix needs the
  // scan's whole recorded set, including the pages that produced no claim: a page that was
  // captured and found healthy is part of the sample and must be visible as such.
  const timeline = useResource<{ evidence: Evidence[] }>(
    scanId ? `/scans/${scanId}/timeline` : null,
    [scanId],
  );

  const evidence = useMemo(
    () => (timeline.data?.evidence ?? []).filter((item) => item.scan_id === scanId),
    [timeline.data, scanId],
  );
  const matrix = useMemo(
    () => (scan.data ? buildMatrix(evidence, scan.data.target_url) : null),
    [evidence, scan.data],
  );

  const references = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of matrix?.rows ?? []) {
      for (const cell of row.cells) {
        if (cell.evidence) map.set(cell.evidence.id, cell.reference);
      }
    }
    return map;
  }, [matrix]);

  // The stage defaults to the observation the claim rests on, not to an arbitrary first row.
  // Derived rather than written by an effect, so it follows the selected finding without a
  // render in which the wrong artifact is shown.
  const defaultEvidence =
    evidence.find((item) => finding?.evidence_ids.includes(item.id)) ?? evidence[0] ?? null;
  const shown =
    (selected && evidence.some((item) => item.id === selected.evidence.id) ? selected : null) ??
    (defaultEvidence
      ? { evidence: defaultEvidence, reference: references.get(defaultEvidence.id) ?? '' }
      : null);

  if (detail.status === 'loading') return <Loading label="Loading the case" lines={6} />;
  if (detail.status === 'error') return <ErrorPanel error={detail.error} onRetry={detail.reload} />;

  const opportunity = detail.data.opportunity;

  return (
    <>
      <div className="pagehead">
        <div>
          <p
            style={{
              font: 'var(--text-meta)/1.5 var(--font-mono)',
              color: 'var(--ink-muted)',
              letterSpacing: '0.05em',
            }}
          >
            <Link to="/opportunities">Review queue</Link> / {docketOf(opportunity.id)}
          </p>
          <h1>{opportunity.account.name}</h1>
          <p>{opportunity.title}</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' }}>
          {finding ? (
            <Chip tone={findingTone(finding).tone}>{findingTone(finding).label}</Chip>
          ) : null}
          <Chip tone="unknown">{opportunity.permission_state.replaceAll('_', ' ')}</Chip>
        </div>
      </div>

      {/* Narrow screens get a sequence, not a squeezed three-column layout. */}
      <div className="casetabs" role="tablist" aria-label="Case sections">
        {(['index', 'evidence', 'finding', 'decision'] as const).map((key) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {TAB_LABEL[key]}
          </button>
        ))}
      </div>

      <div className="case" data-tab={tab}>
        <aside className="case-rail" aria-label="Case context">
          <h2
            style={{
              font: 'var(--text-micro)/1.4 var(--font-mono)',
              letterSpacing: '0.09em',
              textTransform: 'uppercase',
              color: 'var(--ink-muted)',
              marginBottom: 'var(--s3)',
            }}
          >
            This case
          </h2>
          <dl style={{ margin: 0, display: 'grid', gap: 'var(--s3)' }}>
            <div>
              <dt style={railLabel}>Account</dt>
              <dd style={railValue}>{opportunity.account.name}</dd>
            </div>
            <div>
              <dt style={railLabel}>Approved hosts</dt>
              <dd style={railValue}>{opportunity.account.approved_hosts.join(', ')}</dd>
            </div>
            <div>
              <dt style={railLabel}>Detector</dt>
              <dd style={railValue}>
                {finding ? `${finding.detector_id} v${finding.detector_version}` : 'none'}
              </dd>
            </div>
            <div>
              <dt style={railLabel}>Last updated</dt>
              <dd style={railValue}>
                <Timestamp value={opportunity.updated_at} />
              </dd>
            </div>
          </dl>

          {scan.data ? (
            <div style={{ marginTop: 'var(--s6)' }}>
              <CoverageSummary scan={scan.data} />
              <p style={{ marginTop: 'var(--s4)' }}>
                <Link to={`/scans/${scan.data.id}`}>Open the scan record</Link>
              </p>
            </div>
          ) : null}
        </aside>

        <div className="case-main">
          {matrix ? (
            <ObservationMatrix
              model={matrix}
              selectedEvidenceId={shown?.evidence.id ?? null}
              onSelect={(item, reference) => setSelected({ evidence: item, reference })}
            />
          ) : (
            <Loading label="Loading recorded observations" lines={3} />
          )}

          <EvidenceStage evidence={shown?.evidence ?? null} reference={shown?.reference ?? null} />
        </div>

        <div className="case-side">
          {finding ? (
            <>
              {findings.length > 1 ? (
                <FindingPicker
                  findings={findings}
                  currentId={finding.id}
                  onSelect={(next) => {
                    const updated = new URLSearchParams(params);
                    updated.set('finding', next);
                    setParams(updated, { replace: true });
                    setLocalFinding(null);
                    setSelected(null);
                  }}
                />
              ) : null}

              <FindingNarrative
                finding={finding}
                evidence={evidence}
                references={references}
                selectedEvidenceId={shown?.evidence.id ?? null}
                onSelectEvidence={(evidenceId) => {
                  const item = evidence.find((e) => e.id === evidenceId);
                  if (item) setSelected({ evidence: item, reference: references.get(item.id) ?? '' });
                }}
              />

              {finding.state === 'confirmed' ? (
                <ConfirmedNext finding={finding} scan={scan.data} session={session} />
              ) : (
                <ReviewSeam
                  finding={finding}
                  canReview={session.role === 'reviewer' || session.role === 'owner'}
                  onReviewed={(updated) => {
                    setLocalFinding(updated);
                    detail.reload();
                  }}
                />
              )}
            </>
          ) : (
            <Notice tone="unknown" title="No supported finding in this sample">
              <p>
                The inspection completed without a supported defect in the pages it covered.
                That is a result about this sample, not a statement about the whole store.
              </p>
            </Notice>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Findings that still need a decision come before settled ones, newest first. A confirmed
 * or rejected finding never hides one that is waiting.
 */
function orderForReview(findings: Finding[]): Finding[] {
  const rank = (finding: Finding) => {
    if (finding.state === 'candidate' || finding.state === 'stale') return 0;
    if (finding.state === 'unknown') return 1;
    if (finding.state === 'confirmed') return 2;
    return 3;
  };
  return [...findings].sort((a, b) => {
    const byState = rank(a) - rank(b);
    if (byState !== 0) return byState;
    return Date.parse(b.captured_at) - Date.parse(a.captured_at);
  });
}

function FindingPicker({
  findings,
  currentId,
  onSelect,
}: {
  findings: Finding[];
  currentId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor="finding-picker">
        Finding {findings.findIndex((f) => f.id === currentId) + 1} of {findings.length}
      </label>
      <select id="finding-picker" value={currentId} onChange={(event) => onSelect(event.target.value)}>
        {findings.map((item) => (
          <option key={item.id} value={item.id}>
            {item.state} · v{item.version} · {new Date(item.captured_at).toLocaleString()}
          </option>
        ))}
      </select>
      <p className="help">
        This account has several observations of the same root cause. Each is decided on its
        own evidence.
      </p>
    </div>
  );
}

const TAB_LABEL = {
  index: 'Context',
  evidence: 'Evidence',
  finding: 'Finding',
  decision: 'Decision',
} as const;

const railLabel: React.CSSProperties = {
  font: 'var(--text-micro)/1.3 var(--font-mono)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-muted)',
};
const railValue: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--text-meta)',
  overflowWrap: 'anywhere',
};

/** After confirmation the next step is a report, and it is one explicit action. */
function ConfirmedNext({
  finding,
  scan,
  session,
}: {
  finding: Finding;
  scan: Scan | null;
  session: Session;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const canCompose = session.role === 'reviewer' || session.role === 'owner';

  async function compose() {
    if (!scan) return;
    setBusy(true);
    setError(null);
    try {
      const report = await command<{ id: string }>(
        '/reports',
        {
          account_id: scan.account_id,
          scan_id: scan.id,
          finding_versions: [{ finding_id: finding.id, version: finding.version }],
          language: 'en',
          scope_summary: `We inspected ${scan.target_url} and the information page linked from it.`,
        },
        { idempotencyKey: newIdempotencyKey() },
      );
      setReportId(report.id);
    } catch (caught) {
      if (caught instanceof ApiError || caught instanceof NetworkError) setError(caught);
      else setError(new NetworkError('The report could not be created.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="seam">
      <Notice tone="confirmed" title="Confirmed by a reviewer">
        <p>
          Recorded against version {finding.version} on{' '}
          <Timestamp value={finding.reviewed_at} />. The report binds this exact version.
        </p>
      </Notice>
      {error ? <ErrorPanel error={error} /> : null}
      {reportId ? (
        <Link className="btn" data-variant="primary" to={`/reports/${reportId}`}>
          Open the report
        </Link>
      ) : (
        <button
          type="button"
          className="btn"
          data-variant="primary"
          onClick={compose}
          disabled={!canCompose || !scan || busy}
          title={canCompose ? 'Compose a protected report from this confirmed finding.' : 'Requires the reviewer role.'}
        >
          {busy ? 'Composing…' : 'Compose report'}
        </button>
      )}
      <p className="hint">
        Creating a report does not send anything. External delivery is a separate, later
        permission.
      </p>
    </div>
  );
}
