import type { Budget, Scan } from '@oe/contracts';
import { Chip, Money, Timestamp } from './primitives.tsx';

/**
 * CoverageSummary: how much of the intended sample was actually inspected.
 *
 * DESIGN_BRIEF.md: "express '2 of 5 pages captured; size-guide check complete' in context.
 * Do not replace nuanced coverage with a universal health ring."
 */
export function CoverageSummary({ scan }: { scan: Scan }) {
  const { expected_unique_pages: expected, captured_unique_pages: captured } = scan.coverage;
  const complete = captured >= expected;
  return (
    <div className="coverage">
      <h3
        style={{
          font: 'var(--text-micro)/1.4 var(--font-mono)',
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: 'var(--ink-muted)',
        }}
      >
        Coverage
      </h3>
      <p className="fraction">
        {captured} of {expected} pages
      </p>
      <p style={{ fontSize: 'var(--text-meta)', color: 'var(--ink-secondary)' }}>
        {complete
          ? 'The intended sample was captured. This is a sample, not a whole-store inspection.'
          : 'The remaining pages could not be inspected.'}
      </p>
      {scan.coverage.reasons.length > 0 ? (
        <ul>
          {scan.coverage.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * BudgetSummary: limit, spent, reserved and remaining as four separate figures.
 *
 * COPY.md: "Use 'Total scan limit,' 'Spent,' 'Reserved for work in progress,' and
 * 'Remaining.' Show currency."
 */
export function BudgetSummary({ scan }: { scan: Scan }) {
  const { cap, settled, reserved, settlement_uncertain: uncertain } = scan.cost;
  const remaining =
    BigInt(cap.amount_micro) - BigInt(settled.amount_micro) - BigInt(reserved.amount_micro);
  return (
    <div>
      <h3
        style={{
          font: 'var(--text-micro)/1.4 var(--font-mono)',
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: 'var(--ink-muted)',
          marginBottom: 'var(--s3)',
        }}
      >
        Cost
      </h3>
      <div className="budget">
        <div>
          <span className="label">Total scan limit</span>
          <span className="value">
            <Money currency={cap.currency} amountMicro={cap.amount_micro} />
          </span>
        </div>
        <div>
          <span className="label">Spent</span>
          <span className="value">
            <Money currency={settled.currency} amountMicro={settled.amount_micro} />
          </span>
        </div>
        <div>
          <span className="label">Reserved for work in progress</span>
          <span className="value">
            <Money currency={reserved.currency} amountMicro={reserved.amount_micro} />
          </span>
        </div>
        <div>
          <span className="label">Remaining</span>
          <span className="value">
            {remaining < 0n ? (
              <span style={{ color: 'var(--blocked)' }}>over limit</span>
            ) : (
              <Money currency={cap.currency} amountMicro={remaining.toString()} />
            )}
          </span>
        </div>
      </div>
      {uncertain ? (
        <p
          style={{
            marginTop: 'var(--s3)',
            fontSize: 'var(--text-meta)',
            color: 'var(--attention)',
          }}
        >
          A provider result is unresolved. Its reserved amount stays committed until the provider
          settles it.
        </p>
      ) : null}
    </div>
  );
}

/** Real step events, never a synthetic percentage. */
export function ScanTimeline({
  steps,
}: {
  steps: { step_key: string; state: string; attempt: number; updated_at: string }[];
}) {
  if (steps.length === 0) {
    return <p style={{ color: 'var(--ink-secondary)' }}>No steps have been recorded yet.</p>;
  }
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {steps.map((step) => (
        <li
          key={step.step_key}
          style={{
            display: 'flex',
            gap: 'var(--s3)',
            alignItems: 'baseline',
            padding: 'var(--s2) 0',
            borderBottom: '1px solid var(--rule)',
            fontSize: 'var(--text-meta)',
          }}
        >
          <code style={{ minWidth: '18ch' }}>{step.step_key}</code>
          <Chip tone={stepTone(step.state)}>{step.state}</Chip>
          <span style={{ color: 'var(--ink-secondary)' }}>attempt {step.attempt}</span>
          <span style={{ marginInlineStart: 'auto', color: 'var(--ink-muted)' }}>
            <Timestamp value={step.updated_at} />
          </span>
        </li>
      ))}
    </ol>
  );
}

function stepTone(state: string) {
  if (state === 'succeeded') return 'confirmed' as const;
  if (state === 'blocked' || state === 'failed') return 'blocked' as const;
  if (state === 'uncertain') return 'attention' as const;
  return 'unknown' as const;
}

export function scanTone(state: Scan['state']) {
  switch (state) {
    case 'succeeded':
      return { tone: 'confirmed' as const, label: 'collection complete' };
    case 'partial':
      return { tone: 'attention' as const, label: 'partial sample' };
    case 'blocked':
      return { tone: 'blocked' as const, label: 'blocked' };
    case 'failed':
      return { tone: 'blocked' as const, label: 'failed' };
    case 'cancelled':
      return { tone: 'unknown' as const, label: 'cancelled' };
    case 'cancel_requested':
      return { tone: 'attention' as const, label: 'stopping new work' };
    default:
      return { tone: 'unknown' as const, label: state };
  }
}

/** Owner view of the configured cost limits. */
export function BudgetTable({ budgets }: { budgets: Budget[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-meta)' }}>
      <thead>
        <tr>
          {['Scope', 'Limit', 'Spent', 'Reserved', 'State'].map((heading) => (
            <th
              key={heading}
              scope="col"
              style={{
                textAlign: 'start',
                padding: 'var(--s2) var(--s3)',
                borderBottom: '1px solid var(--rule-strong)',
                font: 'var(--text-micro)/1.4 var(--font-mono)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--ink-muted)',
              }}
            >
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {budgets.map((budget) => (
          <tr key={budget.id}>
            <td style={cell}>{budget.scope_kind}</td>
            <td style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>
              <Money currency={budget.currency} amountMicro={budget.limit_micro} />
            </td>
            <td style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>
              <Money currency={budget.currency} amountMicro={budget.settled_micro} />
            </td>
            <td style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>
              <Money currency={budget.currency} amountMicro={budget.reserved_micro} />
            </td>
            <td style={cell}>
              {budget.paused ? (
                <Chip tone="blocked">paused</Chip>
              ) : (
                <Chip tone="confirmed">accepting work</Chip>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const cell: React.CSSProperties = {
  padding: 'var(--s2) var(--s3)',
  borderBottom: '1px solid var(--rule)',
  fontFamily: 'var(--font-mono)',
};
