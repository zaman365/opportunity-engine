import type { ReactNode } from 'react';
import type { Problem } from '@oe/contracts';
import { ApiError, NetworkError } from '../api/client.ts';

/**
 * Shared presentational primitives.
 *
 * COMPONENTS.md requires each of these to carry its own state vocabulary. Status is never
 * conveyed by colour alone: every chip also carries a glyph and a word.
 */

export type Tone = 'confirmed' | 'attention' | 'blocked' | 'unknown';

const GLYPH: Record<Tone, string> = {
  confirmed: '✓',
  attention: '!',
  blocked: '✕',
  unknown: '?',
};

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="chip" data-tone={tone} data-glyph={GLYPH[tone]}>
      {children}
    </span>
  );
}

export function Notice({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="notice" data-tone={tone} role={tone === 'blocked' ? 'alert' : undefined}>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/**
 * EmptyState distinguishes an empty workspace from empty filters from a missing provider.
 * UI_SPEC.md treats these as three different answers, not one blank panel.
 */
export function EmptyState({
  kind,
  title,
  children,
  action,
}: {
  kind: 'workspace' | 'filters' | 'provider';
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty" data-kind={kind}>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

/** A skeleton that matches the real layout and announces what is loading. */
export function Loading({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className="skeleton"
          style={{
            height: index === 0 ? 28 : 16,
            marginBottom: 12,
            width: index === 0 ? '46%' : '100%',
          }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

/**
 * Renders a failure with its stable code and request id.
 *
 * A network failure is reported as unknown rather than as a failure, because the request may
 * well have been admitted.
 */
export function ErrorPanel({
  error,
  onRetry,
}: {
  error: ApiError | NetworkError;
  onRetry?: () => void;
}) {
  if (error instanceof NetworkError) {
    return (
      <Notice tone="attention" title="The request did not reach the server">
        <p>
          Its outcome is unknown. Reload before retrying so a request that was already accepted is
          not repeated.
        </p>
        {onRetry ? (
          <p style={{ marginTop: 8 }}>
            <button type="button" className="btn" onClick={onRetry}>
              Reload
            </button>
          </p>
        ) : null}
      </Notice>
    );
  }
  const problem: Problem = error.problem;
  return (
    <Notice tone={problem.status >= 500 ? 'attention' : 'blocked'} title={problem.title}>
      <p>{problem.detail}</p>
      <p style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-meta)' }}>
        {problem.code} · request {problem.request_id}
      </p>
      {onRetry && problem.retryable ? (
        <p style={{ marginTop: 8 }}>
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : null}
    </Notice>
  );
}

/**
 * Absolute UTC timestamp with a readable local rendering.
 *
 * UI_SPEC.md: "Full timestamps show timezone; relative dates expose absolute values."
 */
export function Timestamp({
  value,
  prefix,
  compact = false,
}: {
  value: string | null;
  prefix?: string;
  /** Drops the timezone suffix for dense tables; the UTC value stays in the title. */
  compact?: boolean;
}) {
  if (!value) return <span>not recorded</span>;
  const date = new Date(value);
  const local = date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(compact ? {} : { timeZoneName: 'short' as const }),
  });
  return (
    <time dateTime={value} title={value}>
      {prefix ? `${prefix} ` : ''}
      {local}
    </time>
  );
}

/**
 * Micro-unit money. Whole units read naturally; provider fractions keep their precision
 * rather than showing six zeros for every amount (COPY.md, "Cost copy").
 */
export function Money({ currency, amountMicro }: { currency: string; amountMicro: string }) {
  const value = BigInt(amountMicro);
  const whole = value / 1_000_000n;
  const fraction = value % 1_000_000n;
  const text =
    fraction === 0n
      ? `${whole}`
      : `${whole}.${fraction.toString().padStart(6, '0').replace(/0+$/, '')}`;
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      {text} <span className="currency">{currency}</span>
    </span>
  );
}
