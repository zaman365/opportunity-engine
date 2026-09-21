import { useState } from 'react';
import type { IssuedReportGrant, Report, ReportGrant, ReportGrants } from '@oe/contracts';
import { ApiError, NetworkError, command, newIdempotencyKey } from '../api/client.ts';
import { useResource } from '../api/hooks.ts';
import { Chip, ErrorPanel, Loading, Notice, Timestamp } from './primitives.tsx';

/**
 * Links that let one person read one version of this report.
 *
 * The screen's job is to make two things unmissable. **The token is shown once** — there is no
 * operation that returns it again, so a link not copied now is a link to be reissued and the
 * old one withdrawn. And **issuing a link sends nothing**: it creates a way in, and putting
 * that way in front of somebody is a separate act this system does not perform.
 *
 * A grant is not a seat. ACCESS_MODEL.md: giving a client a viewer membership so they can read
 * their own case "is the single most likely way this system leaks one customer's data to
 * another." This is the alternative, and the copy says so where an operator will read it.
 */
export function DeliveryPanel({
  report,
  canIssue,
}: {
  report: Report & { state: string };
  canIssue: boolean;
}) {
  const grants = useResource<ReportGrants>(`/reports/${report.id}/grants`, [report.id]);
  const [issued, setIssued] = useState<IssuedReportGrant | null>(null);

  const published = report.state === 'published';

  return (
    <section className="seam no-print" aria-label="Protected links">
      <h2
        style={{
          font: 'var(--text-micro)/1.4 var(--font-mono)',
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: 'var(--ink-muted)',
        }}
      >
        Protected links
      </h2>

      {issued ? <FreshLink issued={issued} onDismiss={() => setIssued(null)} /> : null}

      {published && canIssue ? (
        <IssueForm
          reportId={report.id}
          onIssued={(next) => {
            setIssued(next);
            grants.reload();
          }}
        />
      ) : null}

      {!published ? (
        <p className="hint">
          Only a published version can be delivered. A draft is a working document, and an approved
          one has not been published yet.
        </p>
      ) : null}

      {grants.status === 'loading' ? <Loading label="Loading links" lines={2} /> : null}
      {grants.status === 'error' ? (
        <ErrorPanel error={grants.error} onRetry={grants.reload} />
      ) : null}
      {grants.status === 'ready' && grants.data.items.length === 0 ? (
        <p className="hint">No link has been issued for this report.</p>
      ) : null}
      {grants.status === 'ready'
        ? grants.data.items.map((grant) => (
            <GrantRow key={grant.id} grant={grant} canRevoke={canIssue} onRevoked={grants.reload} />
          ))
        : null}
    </section>
  );
}

function IssueForm({
  reportId,
  onIssued,
}: {
  reportId: string;
  onIssued: (issued: IssuedReportGrant) => void;
}) {
  const [note, setNote] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      onIssued(
        await command<IssuedReportGrant>(
          `/reports/${reportId}/grants`,
          { recipient_note: note, recipient_ref: ref },
          { idempotencyKey: newIdempotencyKey() },
        ),
      );
      setNote('');
      setRef('');
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof NetworkError
          ? caught
          : new NetworkError('The link could not be issued.'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <label htmlFor="grant-note">Who is this link for</label>
      <input
        id="grant-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="e.g. the person who requested the check"
      />
      <label htmlFor="grant-ref">Their address, for your own records</label>
      <input
        id="grant-ref"
        value={ref}
        onChange={(event) => setRef(event.target.value)}
        placeholder="name@example.com"
      />
      {error ? <ErrorPanel error={error} /> : null}
      <button
        type="button"
        className="btn"
        data-variant="primary"
        onClick={issue}
        disabled={busy || note.trim().length < 3 || ref.trim().length < 3}
      >
        {busy ? 'Issuing…' : 'Issue a protected link'}
      </button>
      <p className="help">
        The address is hashed before it is stored and never shown again — it exists so you can find
        and withdraw this link later. Issuing sends nothing.
      </p>
    </div>
  );
}

/** Shown once, immediately after issue, and never reconstructable from anything stored. */
function FreshLink({ issued, onDismiss }: { issued: IssuedReportGrant; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.url);
      setCopied(true);
    } catch {
      // A clipboard the browser refuses is not an error worth a panel: the link is on screen
      // and selectable, which is the fallback anyway.
      setCopied(false);
    }
  }

  return (
    <Notice tone="attention" title="Copy this link now">
      <p>
        It is shown once. Nothing stores it in a readable form, so if it is lost the only remedy is
        to issue a new one and withdraw this.
      </p>
      <p
        style={{
          font: 'var(--text-meta)/1.5 var(--font-mono)',
          overflowWrap: 'anywhere',
          userSelect: 'all',
          marginTop: 'var(--s2)',
        }}
      >
        {issued.url}
      </p>
      <p style={{ marginTop: 'var(--s2)' }}>
        Expires <Timestamp value={issued.grant.expires_at} />.
      </p>
      <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
        <button type="button" className="btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <button type="button" className="btn" onClick={onDismiss}>
          Done
        </button>
      </div>
    </Notice>
  );
}

function GrantRow({
  grant,
  canRevoke,
  onRevoked,
}: {
  grant: ReportGrant;
  canRevoke: boolean;
  onRevoked: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await command<ReportGrant>(
        `/report-grants/${grant.id}/revoke`,
        { reason },
        { idempotencyKey: newIdempotencyKey() },
      );
      onRevoked();
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof NetworkError
          ? caught
          : new NetworkError('The link could not be withdrawn.'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="grant" data-state={grant.state}>
      <header>
        <span>{grant.recipient_note}</span>
        <Chip tone={STATE_TONE[grant.state]}>{STATE_LABEL[grant.state]}</Chip>
      </header>
      <p className="hint">
        Version {grant.report_version} · issued <Timestamp value={grant.created_at} /> ·{' '}
        {grant.state === 'revoked' ? 'withdrawn ' : 'expires '}
        <Timestamp value={grant.state === 'revoked' ? grant.revoked_at : grant.expires_at} />
        {grant.revoke_reason ? ` — ${grant.revoke_reason}` : null}
      </p>

      {error ? <ErrorPanel error={error} /> : null}

      {grant.state === 'live' && canRevoke ? (
        <div className="field">
          <label htmlFor={`revoke-${grant.id}`}>Withdraw this link</label>
          <input
            id={`revoke-${grant.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why it is being withdrawn"
          />
          <button
            type="button"
            className="btn"
            onClick={revoke}
            disabled={busy || reason.trim().length === 0}
          >
            {busy ? 'Withdrawing…' : 'Withdraw'}
          </button>
          <p className="help">
            Takes effect on the next read — there is no session to expire. The record is kept.
          </p>
        </div>
      ) : null}
    </article>
  );
}

const STATE_LABEL: Record<ReportGrant['state'], string> = {
  live: 'live',
  expired: 'expired',
  revoked: 'withdrawn',
};

const STATE_TONE: Record<ReportGrant['state'], 'confirmed' | 'attention' | 'blocked' | 'unknown'> =
  {
    live: 'confirmed',
    expired: 'unknown',
    revoked: 'blocked',
  };
