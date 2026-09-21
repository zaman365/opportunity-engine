import { useRef, useState } from 'react';
import type { Finding } from '@oe/contracts';
import { ApiError, NetworkError, command, newIdempotencyKey } from '../api/client.ts';
import { Notice } from './primitives.tsx';

/**
 * The review seam: where a human decision is committed against a specific version.
 *
 * DESIGN_BRIEF.md asks for "a persistent yet quiet strip [joining] source state, unsaved
 * decision, reason and next action. It belongs to the selected finding rather than an
 * unrelated global toolbar."
 *
 * The typed reason survives a version conflict, a network failure and a re-render. Nothing
 * is shown as decided until the server has acknowledged it — there is no optimistic
 * "approved" state for a human judgement.
 */
/**
 * Remounted per finding by its key, so every piece of local state — the note, the
 * acknowledgement, the idempotency key — starts clean for a new decision without an effect
 * resetting it, while a *version* change of the same finding keeps the typed note.
 */
export function ReviewSeam(props: {
  finding: Finding;
  canReview: boolean;
  onReviewed: (finding: Finding) => void;
}) {
  return <ReviewSeamForm key={props.finding.id} {...props} />;
}

function ReviewSeamForm({
  finding,
  canReview,
  onReviewed,
}: {
  finding: Finding;
  canReview: boolean;
  onReviewed: (finding: Finding) => void;
}) {
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState<'confirm' | 'reject' | 'unknown' | null>(null);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  // One key per typed decision, so a retry after a timeout cannot record two reviews.
  const idempotencyKey = useRef(newIdempotencyKey());

  const terminal = finding.state === 'rejected';
  const reasonTooShort = reason.trim().length < 5;

  async function submit(decision: 'confirm' | 'reject' | 'unknown') {
    setPending(decision);
    setError(null);
    try {
      const updated = await command<Finding>(
        `/findings/${finding.id}/review`,
        {
          expected_version: finding.version,
          decision,
          reason: reason.trim(),
          acknowledged_limitations: true,
        },
        { idempotencyKey: idempotencyKey.current },
      );
      setReason('');
      setAcknowledged(false);
      idempotencyKey.current = newIdempotencyKey();
      onReviewed(updated);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught);
        if (caught.code === 'STALE_REVIEW' || caught.code === 'VERSION_CONFLICT') {
          setConflictVersion(finding.version);
        }
      } else if (caught instanceof NetworkError) {
        setError(caught);
      } else {
        setError(new NetworkError('The review could not be submitted.'));
      }
    } finally {
      setPending(null);
    }
  }

  if (terminal) {
    return (
      <div className="seam">
        <Notice tone="blocked" title="This finding was rejected">
          <p>
            Rejections are kept as audit history and cannot be reversed. A new scan can
            supersede this finding with fresh evidence.
          </p>
        </Notice>
      </div>
    );
  }

  return (
    <div className="seam">
      <p className="hint" style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s3)' }}>
        <span>Deciding on version {finding.version}</span>
        {reason.trim() ? <span aria-live="polite">Unsaved note</span> : null}
      </p>

      {conflictVersion !== null ? (
        <Notice tone="attention" title="This finding changed while you were reviewing">
          <p>
            Your note is kept below. Reload the case, read the current evidence, then decide
            again — the previous version cannot be approved retroactively.
          </p>
        </Notice>
      ) : error ? (
        <Notice tone={error instanceof NetworkError ? 'attention' : 'blocked'} title={errorTitle(error)}>
          <p>{error.message}</p>
        </Notice>
      ) : null}

      <div className="field">
        <label htmlFor="review-reason">Reviewer note</label>
        <textarea
          id="review-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="State what the recorded evidence supports, and its scope."
          aria-describedby="review-reason-help"
          disabled={!canReview}
        />
        <p className="help" id="review-reason-help">
          At least five characters. The note is stored with the decision and the exact
          finding version.
        </p>
      </div>

      <label style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'flex-start', fontSize: 'var(--text-meta)' }}>
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          disabled={!canReview}
          style={{ marginTop: 3 }}
        />
        <span>
          I have read the limits above and understand this covers only the inspected sample.
        </span>
      </label>

      <div className="actions">
        <button
          type="button"
          className="btn"
          data-variant="primary"
          disabled={!canReview || reasonTooShort || !acknowledged || pending !== null}
          onClick={() => submit('confirm')}
          title={confirmBlockedReason(canReview, reasonTooShort, acknowledged)}
        >
          {pending === 'confirm' ? 'Recording…' : 'Confirm finding'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canReview || reasonTooShort || pending !== null}
          onClick={() => submit('reject')}
        >
          {pending === 'reject' ? 'Recording…' : 'Reject'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canReview || reasonTooShort || pending !== null}
          onClick={() => submit('unknown')}
        >
          Not established
        </button>
      </div>

      {!canReview ? (
        <p className="hint">
          Your membership does not include the reviewer role, so you can read this case but
          not decide it.
        </p>
      ) : null}
    </div>
  );
}

function errorTitle(error: ApiError | NetworkError): string {
  return error instanceof NetworkError
    ? 'The decision did not reach the server'
    : error.problem.title;
}

/** Every disabled action states its reason, per UI_SPEC.md's interaction invariants. */
function confirmBlockedReason(canReview: boolean, reasonTooShort: boolean, acknowledged: boolean): string {
  if (!canReview) return 'Requires the reviewer role.';
  if (reasonTooShort) return 'Write a note of at least five characters first.';
  if (!acknowledged) return 'Acknowledge the limits of this evidence first.';
  return 'Record this decision against the current version.';
}
