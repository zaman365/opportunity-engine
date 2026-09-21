import { useState } from 'react';
import type { IntakeChannels, IntakeRequest, IntakeRequests, Session } from '@oe/contracts';
import { ApiError, NetworkError, command, newIdempotencyKey } from '../api/client.ts';
import { useResource } from '../api/hooks.ts';
import {
  Chip,
  EmptyState,
  ErrorPanel,
  Loading,
  Notice,
  Timestamp,
} from '../components/primitives.tsx';

/**
 * Requests that came in through a venture's own site.
 *
 * The screen has one job beyond listing: keeping the difference between *asked* and
 * *allowed* impossible to miss. A verified request means somebody proved control of an
 * inbox. It does not mean they control the site they named, and nothing here creates an
 * account or an authorization — those stay owner acts against a target whose ownership
 * somebody actually established.
 *
 * So the authority claim is displayed as a quotation, in the requester's words, labelled as
 * a claim. A screen that rendered it as a fact would be the place this system started
 * scanning sites on the say-so of strangers.
 */
export function RequestsRoute({ session }: { session: Session }) {
  const [state, setState] = useState<'verified' | 'pending_verification' | 'all'>('verified');
  const query = state === 'all' ? '' : `?state=${state}`;
  const requests = useResource<IntakeRequests>(`/intake-requests${query}`, [state]);
  const channels = useResource<IntakeChannels>('/intake-channels');

  const canDecide = session.role === 'reviewer' || session.role === 'owner';

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Requested checks</h1>
          <p>
            Somebody asked for a check through one of your sites. A verified request proves they
            control the address they gave — nothing more.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s2)' }}>
          {(['verified', 'pending_verification', 'all'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className="btn"
              data-variant={state === key ? 'primary' : undefined}
              onClick={() => setState(key)}
            >
              {FILTER_LABEL[key]}
            </button>
          ))}
        </div>
      </div>

      <OpenForms channels={channels} />

      {requests.status === 'loading' ? <Loading label="Loading requests" lines={4} /> : null}
      {requests.status === 'error' ? (
        <ErrorPanel error={requests.error} onRetry={requests.reload} />
      ) : null}

      {requests.status === 'ready' && requests.data.items.length === 0 ? (
        <EmptyState kind="filters" title="Nothing waiting">
          No request is in this state. Requests arrive through a venture site and appear here once
          the requester has confirmed their address.
        </EmptyState>
      ) : null}

      {requests.status === 'ready'
        ? requests.data.items.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              canDecide={canDecide}
              onDecided={requests.reload}
            />
          ))
        : null}
    </>
  );
}

const FILTER_LABEL = {
  verified: 'Confirmed address',
  pending_verification: 'Awaiting confirmation',
  all: 'All',
} as const;

function OpenForms({ channels }: { channels: ReturnType<typeof useResource<IntakeChannels>> }) {
  if (channels.status !== 'ready') return null;
  const open = channels.data.items.filter((channel) => channel.enabled);
  if (channels.data.items.length === 0) return null;
  return (
    <p
      style={{
        fontSize: 'var(--text-meta)',
        color: 'var(--ink-secondary)',
        marginBottom: 'var(--s5)',
      }}
    >
      {open.length > 0
        ? `Open on ${open.map((c) => c.host).join(', ')}. Closing a form is an owner action and takes effect immediately.`
        : 'Every form is closed. The public endpoints answer as though they were never built.'}
    </p>
  );
}

function RequestCard({
  request,
  canDecide,
  onDecided,
}: {
  request: IntakeRequest;
  canDecide: boolean;
  onDecided: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      await command<IntakeRequest>(
        `/intake-requests/${request.id}/decline`,
        { expected_version: request.version, reason },
        { idempotencyKey: newIdempotencyKey() },
      );
      onDecided();
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof NetworkError
          ? caught
          : new NetworkError('The request could not be declined.'),
      );
    } finally {
      setBusy(false);
    }
  }

  const open = request.state === 'verified' || request.state === 'pending_verification';

  return (
    <article className="request">
      <header>
        <h2>{request.target_host}</h2>
        <Chip tone={STATE_TONE[request.state]}>{STATE_LABEL[request.state]}</Chip>
      </header>

      <dl className="request-facts">
        <dt>Page</dt>
        <dd style={{ overflowWrap: 'anywhere' }}>{request.target_url}</dd>
        <dt>Checks asked for</dt>
        <dd>{request.requested_detectors.join(', ')}</dd>
        <dt>Arrived</dt>
        <dd>
          <Timestamp value={request.submitted_at} />
        </dd>
        {request.contact_email ? (
          <>
            <dt>Contact</dt>
            <dd>{request.contact_email}</dd>
          </>
        ) : null}
      </dl>

      <blockquote className="request-claim">
        <p>“{request.purpose}”</p>
        <p>“{request.authority_claim}”</p>
        <footer>The requester’s own words. Recorded as a claim, not established as a fact.</footer>
      </blockquote>

      {request.state === 'verified' && request.account_id === null ? (
        <Notice tone="attention" title="Confirmed address, no authority yet">
          <p>
            This person confirmed the address they gave. That says nothing about whether they
            control <b>{request.target_host}</b>. Before any scan runs, an owner has to establish
            that separately, record the account with its approved hosts, and record a scan
            authorization against it.
          </p>
        </Notice>
      ) : null}

      {request.marketing_consent ? (
        <Notice tone="confirmed" title="Separately agreed to be contacted">
          <p>Recorded as its own act, not inferred from this request.</p>
        </Notice>
      ) : (
        <p className="hint">
          Asking for a check is not agreeing to be marketed to. Nothing here records consent for
          anything beyond answering this request.
        </p>
      )}

      {error ? <ErrorPanel error={error} /> : null}

      {open && canDecide ? (
        <div className="field">
          <label htmlFor={`decline-${request.id}`}>Decline this request</label>
          <input
            id={`decline-${request.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why it is being declined"
          />
          <button
            type="button"
            className="btn"
            onClick={decline}
            disabled={busy || reason.trim().length === 0}
          >
            {busy ? 'Declining…' : 'Decline'}
          </button>
          <p className="help">
            The record is kept with your reason. The requester is told only that it is closed — your
            reason is internal and may be about them.
          </p>
        </div>
      ) : null}

      {request.state === 'declined' && request.decision_reason ? (
        <p className="hint">
          Declined <Timestamp value={request.decided_at} />: {request.decision_reason}
        </p>
      ) : null}
    </article>
  );
}

const STATE_LABEL: Record<IntakeRequest['state'], string> = {
  pending_verification: 'awaiting confirmation',
  verified: 'address confirmed',
  declined: 'declined',
  expired: 'expired',
  converted: 'account recorded',
};

const STATE_TONE: Record<
  IntakeRequest['state'],
  'confirmed' | 'attention' | 'blocked' | 'unknown'
> = {
  pending_verification: 'unknown',
  verified: 'attention',
  declined: 'blocked',
  expired: 'unknown',
  converted: 'confirmed',
};
