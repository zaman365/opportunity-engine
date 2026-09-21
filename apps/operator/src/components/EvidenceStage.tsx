import { useEffect, useRef, useState } from 'react';
import type { Evidence } from '@oe/contracts';
import { evidenceContentUrl } from '../api/client.ts';
import { useNow } from '../api/hooks.ts';
import { Timestamp } from './primitives.tsx';

/**
 * The artifact and its provenance.
 *
 * UI_SPEC.md: "Original resolution and capture context remain available; don't blur
 * authentic evidence for aesthetic effect." The image is never decorated, never animated
 * and never placed behind a translucent panel.
 */
export function EvidenceStage({
  evidence,
  reference,
}: {
  evidence: Evidence | null;
  reference: string | null;
}) {
  const [zoomed, setZoomed] = useState(false);
  // Which artifact failed to load, rather than a boolean an effect has to reset: selecting a
  // different observation must not inherit the previous one's failure.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const now = useNow();
  const imageFailed = evidence !== null && failedFor === evidence.id;

  if (!evidence) {
    return (
      <div className="stage">
        <div className="stage-actions">
          <h3
            style={{
              font: 'var(--text-micro)/1.4 var(--font-mono)',
              letterSpacing: '0.09em',
              textTransform: 'uppercase',
              color: 'var(--ink-muted)',
            }}
          >
            Artifact
          </h3>
        </div>
        <figure>
          <div className="unavailable">
            <p>Select an observation above to inspect what was recorded.</p>
          </div>
        </figure>
      </div>
    );
  }

  const expired = Date.parse(evidence.expires_at) <= now;
  const available = evidence.content_available && !evidence.redacted && !expired && !imageFailed;

  return (
    <div className="stage">
      <div className="stage-actions">
        <h3
          style={{
            font: 'var(--text-micro)/1.4 var(--font-mono)',
            letterSpacing: '0.09em',
            textTransform: 'uppercase',
            color: 'var(--ink-muted)',
          }}
        >
          Artifact {reference ?? ''}
        </h3>
        {available ? (
          <button type="button" className="btn" onClick={() => setZoomed(true)}>
            Enlarge
          </button>
        ) : null}
      </div>

      <figure>
        {available ? (
          <img
            src={evidenceContentUrl(evidence.id)}
            alt={`Recorded capture of ${evidence.final_url}, HTTP ${evidence.http_status ?? 'no response'}`}
            onError={() => setFailedFor(evidence.id)}
          />
        ) : (
          <div className="unavailable">
            <p>
              <strong>The stored artifact cannot be shown.</strong>
            </p>
            <p style={{ marginTop: 8 }}>{unavailableReason(evidence, expired, imageFailed)}</p>
            <p
              style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-meta)' }}
            >
              The recorded observation below is unaffected.
            </p>
          </div>
        )}
        <figcaption>
          Recorded response to <code>{evidence.final_url}</code>. Synthetic local fixture — not a
          capture of a real merchant.
        </figcaption>
      </figure>

      <SourceStrip evidence={evidence} />

      {zoomed ? <ArtifactViewer evidence={evidence} onClose={() => setZoomed(false)} /> : null}
    </div>
  );
}

function unavailableReason(evidence: Evidence, expired: boolean, imageFailed: boolean): string {
  if (evidence.redacted) return 'It was redacted, so its bytes were removed.';
  if (expired) return 'It passed its retention date and is no longer stored.';
  if (imageFailed) return 'The stored object could not be retrieved.';
  return 'No image artifact was stored for this observation.';
}

/** Provenance in one line, expandable in place. */
function SourceStrip({ evidence }: { evidence: Evidence }) {
  const c = evidence.conditions;
  return (
    <details className="sourcestrip">
      <summary>
        <span>HTTP {evidence.http_status ?? '—'}</span>
        <span>
          {c.viewport_width}×{c.viewport_height}
        </span>
        <span>{c.locale}</span>
        <span>{c.variant ?? 'no selected variant'}</span>
        <span>
          <Timestamp value={c.captured_at} />
        </span>
        <span style={{ marginInlineStart: 'auto' }}>capture details ▾</span>
      </summary>
      <dl>
        <div>
          <dt>Requested</dt>
          <dd>{evidence.source_url}</dd>
        </div>
        <div>
          <dt>Final URL</dt>
          <dd>{evidence.final_url}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{c.session_id}</dd>
        </div>
        <div>
          <dt>Browser</dt>
          <dd>{c.browser_version}</dd>
        </div>
        <div>
          <dt>Consent state</dt>
          <dd>{c.consent_state}</dd>
        </div>
        <div>
          <dt>Test region</dt>
          <dd>{c.test_region ?? 'not recorded'}</dd>
        </div>
        <div>
          <dt>Complete</dt>
          <dd>{evidence.complete ? 'yes' : 'no'}</dd>
        </div>
        <div>
          <dt>Content hash</dt>
          <dd style={{ overflowWrap: 'anywhere' }}>{evidence.sha256}</dd>
        </div>
        <div>
          <dt>Retained until</dt>
          <dd>
            <Timestamp value={evidence.expires_at} />
          </dd>
        </div>
      </dl>
    </details>
  );
}

/** A labelled viewer with focus trapping and Escape-to-close, returning focus on exit. */
function ArtifactViewer({ evidence, onClose }: { evidence: Evidence; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
      if (event.key === 'Tab') {
        // Two focusable stops only, so the trap is a simple wrap.
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], [tabindex="0"]',
        );
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Enlarged capture of ${evidence.final_url}`}
      ref={dialogRef}
      tabIndex={-1}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgb(20 24 29 / 72%)',
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--s6)',
        zIndex: 30,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: 'var(--paper)',
          borderRadius: 'var(--radius-dialog)',
          boxShadow: 'var(--shadow-layer)',
          maxWidth: 'min(1100px, 100%)',
          maxHeight: '100%',
          overflow: 'auto',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 'var(--s4)',
            alignItems: 'center',
            padding: 'var(--s4)',
            borderBottom: '1px solid var(--rule)',
          }}
        >
          <p style={{ font: 'var(--text-meta)/1.5 var(--font-mono)', overflowWrap: 'anywhere' }}>
            {evidence.final_url} · HTTP {evidence.http_status ?? '—'}
          </p>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <img
          src={evidenceContentUrl(evidence.id)}
          alt={`Enlarged capture of ${evidence.final_url}`}
          style={{ display: 'block', width: '100%', height: 'auto' }}
        />
      </div>
    </div>
  );
}
