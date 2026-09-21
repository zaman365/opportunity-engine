import { useState } from 'react';
import type { EligibleOffer, OfferDraft, OfferMatch, OfferPrice } from '@oe/contracts';
import { ApiError, NetworkError, command, newIdempotencyKey } from '../api/client.ts';
import { useResource } from '../api/hooks.ts';
import { ErrorPanel, Loading, Notice, Timestamp } from './primitives.tsx';

/**
 * What a confirmed case is eligible for, and at what price.
 *
 * The rule this panel exists to make visible: the price comes from a catalogue an owner
 * approved, never from this screen. There is no price field here and no way to type one.
 * A scope that has no approved price is shown as unavailable with the reason, rather than
 * hidden — a reviewer who cannot see why a scope is missing will invent an explanation.
 *
 * BUILD_SPEC.md §9: "Price/scope from catalog, not free generation."
 */
export function ScopePanel({
  opportunityId,
  canDraft,
}: {
  opportunityId: string;
  canDraft: boolean;
}) {
  const match = useResource<OfferMatch>(`/opportunities/${opportunityId}/offers`, [opportunityId]);
  const drafts = useResource<{ items: OfferDraft[] }>(
    `/opportunities/${opportunityId}/offer-drafts`,
    [opportunityId],
  );

  if (match.status === 'loading') return <Loading label="Matching approved scopes" lines={3} />;
  if (match.status === 'error') return <ErrorPanel error={match.error} onRetry={match.reload} />;

  const open = (drafts.data?.items ?? []).filter((draft) => draft.state === 'draft');
  const settled = (drafts.data?.items ?? []).filter((draft) => draft.state !== 'draft');

  // An eligible scope with unmet prerequisites appears in both lists: the matcher reports it
  // as eligible-but-not-draftable AND records why it cannot be drafted. Its card already says
  // so in full, so counting it again under "unavailable" would tell a reviewer a scope is both
  // on offer and not.
  const shown = new Set(match.data.eligible.map((entry) => entry.offer.sku));
  const unavailable = match.data.rejected.filter((entry) => !shown.has(entry.sku));

  function reload() {
    match.reload();
    drafts.reload();
  }

  return (
    <section className="seam" aria-label="Eligible scopes">
      <h2
        style={{
          font: 'var(--text-micro)/1.4 var(--font-mono)',
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: 'var(--ink-muted)',
        }}
      >
        Eligible scope
      </h2>

      {open.map((draft) => (
        <DraftCard key={draft.id} draft={draft} canWithdraw={canDraft} onChanged={reload} />
      ))}

      {match.data.eligible
        .filter((entry) => !open.some((draft) => draft.offer_sku === entry.offer.sku))
        .map((entry) => (
          <OfferCard
            key={entry.offer.id}
            entry={entry}
            opportunityId={opportunityId}
            canDraft={canDraft}
            capacityReached={match.data.capacity_reached}
            onDrafted={reload}
          />
        ))}

      {match.data.route_to_manual_quotation ? (
        <Notice tone="unknown" title="No catalogue scope covers this">
          <p>
            {match.data.rejected.some((entry) => entry.reason === 'no_confirmed_finding')
              ? 'Nothing on this case has been confirmed yet. A candidate is a question, not work to quote.'
              : 'The confirmed work here is outside every approved scope. That is a quotation conversation, not a reason to stretch an existing one.'}
          </p>
        </Notice>
      ) : null}

      {match.data.capacity_reached && match.data.eligible.length > 0 ? (
        <Notice tone="attention" title="Delivery capacity is committed">
          <p>
            {match.data.open_commitments} of {match.data.delivery_capacity} slots are taken. Quote
            the next available window rather than adding another commitment.
          </p>
        </Notice>
      ) : null}

      {unavailable.length > 0 ? <Unavailable rejected={unavailable} /> : null}

      {settled.length > 0 ? (
        <details>
          <summary>
            {settled.length} withdrawn {settled.length === 1 ? 'draft' : 'drafts'}
          </summary>
          <ul style={{ fontSize: 'var(--text-meta)', color: 'var(--ink-secondary)' }}>
            {settled.map((draft) => (
              <li key={draft.id}>
                {draft.offer_sku} · {formatPrice(draft.price)} · withdrawn{' '}
                <Timestamp value={draft.withdrawn_at} />
                {draft.withdraw_reason ? ` — ${draft.withdraw_reason}` : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function OfferCard({
  entry,
  opportunityId,
  canDraft,
  capacityReached,
  onDrafted,
}: {
  entry: EligibleOffer;
  opportunityId: string;
  canDraft: boolean;
  capacityReached: boolean;
  onDrafted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);

  async function draft() {
    setBusy(true);
    setError(null);
    try {
      await command<OfferDraft>(
        `/opportunities/${opportunityId}/offer-drafts`,
        { offer_id: entry.offer.id },
        { idempotencyKey: newIdempotencyKey() },
      );
      onDrafted();
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof NetworkError
          ? caught
          : new NetworkError('The scope could not be drafted.'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="offer" data-draftable={entry.draftable}>
      <header>
        <h3>{entry.offer.sku}</h3>
        <p className="offer-price">
          {formatPrice(entry.offer.price)}
          {entry.offer.effort_band ? ` · ${entry.offer.effort_band}` : null}
        </p>
      </header>
      <p>{entry.offer.promise}</p>

      <dl className="offer-scope">
        <dt>Includes</dt>
        <dd>{entry.offer.inclusions.join('; ')}</dd>
        <dt>Excludes</dt>
        <dd>{entry.offer.exclusions.join('; ')}</dd>
        <dt>Acceptance</dt>
        <dd>{entry.offer.acceptance.join('; ')}</dd>
      </dl>

      {entry.unmet_prerequisites.length > 0 ? (
        <Notice tone="attention" title="Prerequisites not recorded">
          <p>
            An owner has to record each of these, with a note, before this scope can be drafted:
          </p>
          <ul>
            {entry.unmet_prerequisites.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {error ? <ErrorPanel error={error} /> : null}

      <button
        type="button"
        className="btn"
        data-variant="primary"
        onClick={draft}
        disabled={!canDraft || !entry.draftable || busy}
        title={
          !canDraft
            ? 'Requires the reviewer role.'
            : entry.unmet_prerequisites.length > 0
              ? 'Record the prerequisites first.'
              : capacityReached
                ? 'Delivery capacity is fully committed.'
                : 'Draft this scope at its approved price.'
        }
      >
        {busy ? 'Drafting…' : 'Draft this scope'}
      </button>
      <p className="hint">
        Drafting records a scope internally. It sends nothing and commits nobody to anything.
      </p>
    </article>
  );
}

function DraftCard({
  draft,
  canWithdraw,
  onChanged,
}: {
  draft: OfferDraft;
  canWithdraw: boolean;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      await command<OfferDraft>(
        `/offer-drafts/${draft.id}/withdraw`,
        { expected_version: draft.version, reason },
        { idempotencyKey: newIdempotencyKey() },
      );
      onChanged();
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof NetworkError
          ? caught
          : new NetworkError('The draft could not be withdrawn.'),
      );
    } finally {
      setBusy(false);
    }
  }

  const promise = typeof draft.snapshot['promise'] === 'string' ? draft.snapshot['promise'] : null;

  return (
    <article className="offer" data-state="draft">
      <Notice tone="confirmed" title={`${draft.offer_sku} drafted`}>
        <p>
          {formatPrice(draft.price)}, recorded <Timestamp value={draft.created_at} /> against
          catalogue version {draft.offer_version}.
        </p>
        {promise ? <p>{promise}</p> : null}
        <p className="hint">
          This price is a snapshot. A later catalogue change does not reprice what was drafted here.
        </p>
      </Notice>

      {error ? <ErrorPanel error={error} /> : null}

      {canWithdraw ? (
        <div className="field">
          <label htmlFor={`withdraw-${draft.id}`}>Withdraw this draft</label>
          <input
            id={`withdraw-${draft.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why it is being withdrawn"
          />
          <button
            type="button"
            className="btn"
            onClick={withdraw}
            disabled={busy || reason.trim().length === 0}
          >
            {busy ? 'Withdrawing…' : 'Withdraw'}
          </button>
          <p className="help">
            The draft is kept and marked withdrawn, with your reason. Nothing is deleted.
          </p>
        </div>
      ) : null}
    </article>
  );
}

/** Why a catalogue entry is not on offer. Shown, not swallowed. */
function Unavailable({ rejected }: { rejected: OfferMatch['rejected'] }) {
  return (
    <details>
      <summary>
        {rejected.length} {rejected.length === 1 ? 'scope is' : 'scopes are'} unavailable
      </summary>
      <ul style={{ fontSize: 'var(--text-meta)', color: 'var(--ink-secondary)' }}>
        {rejected.map((entry) => (
          <li key={`${entry.sku}-${entry.reason}`}>
            <b>{entry.sku}</b> — {REASON[entry.reason]}
          </li>
        ))}
      </ul>
    </details>
  );
}

const REASON: Record<OfferMatch['rejected'][number]['reason'], string> = {
  no_confirmed_finding: 'nothing on this case is confirmed yet',
  detector_not_supported_by_any_sku: 'it does not cover what was found here',
  sku_not_enabled: 'the owner has not enabled it for sale',
  sku_has_no_approved_price: 'no owner-approved price, so it cannot be quoted',
  prerequisites_unmet: 'its prerequisites are not recorded for this account',
  delivery_capacity_reached: 'delivery capacity is fully committed',
};

/**
 * Minor units to a readable amount.
 *
 * Deliberately local and BigInt-based. `@oe/domain` has the same arithmetic, but the operator
 * bundle may not import it (see the `no-restricted-imports` rule in eslint.config.js: that
 * package reaches Node built-ins). Parsing through a float would be wrong for the same reason
 * the wire format is a string.
 */
function formatPrice(price: OfferPrice | null): string {
  if (price === null) return 'no approved price';
  const value = BigInt(price.amount_minor);
  const amount = `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
  const tax = price.tax_treatment === 'net' ? ' net' : '';
  return `${amount} ${price.currency}${tax}`;
}
