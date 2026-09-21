import { useCallback, useEffect, useState } from 'react';
import type { Budgets, Session } from '@oe/contracts';
import { useResource } from '../api/hooks.ts';
import { BudgetTable } from '../components/panels.tsx';
import { Chip, ErrorPanel, Loading, Notice } from '../components/primitives.tsx';

interface Readiness {
  status: 'healthy' | 'not_ready';
  environment: string;
  missing_bindings: string[];
}

/**
 * Owner settings: what authority and capacity exist.
 *
 * UI_SPEC.md: "A disabled future integration belongs in a clearly explained settings
 * inventory, not as a blank page masquerading as a feature." The inventory below is that
 * explanation; nothing here pretends a provider is connected, and nothing here can turn one
 * on — that is an owner decision recorded outside the application.
 */
export function SettingsRoute({ session }: { session: Session }) {
  const budgets = useResource<Budgets>('/budgets');

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Settings</h1>
          <p>Cost limits, adapter status and the capabilities this build does not have.</p>
        </div>
        <Chip tone="unknown">signed in as {session.role}</Chip>
      </div>

      <div className="panel">
        <h2>Cost limits</h2>
        <p style={{ color: 'var(--ink-secondary)', marginBottom: 'var(--s4)' }}>
          Every chargeable step reserves against all applicable scopes before it starts. Automatic
          top-ups are not implemented, and stopping work does not reverse cost a provider has
          already incurred.
        </p>
        {budgets.status === 'ready' ? (
          <>
            {/* Owner-controlled ceilings. Per-scan caps are created per admission and belong
                to their scan, so they are summarised rather than listed row by row. */}
            <BudgetTable budgets={budgets.data.items.filter((b) => b.scope_kind !== 'scan')} />
            <p
              style={{
                marginTop: 'var(--s3)',
                fontSize: 'var(--text-meta)',
                color: 'var(--ink-secondary)',
              }}
            >
              {budgets.data.items.filter((b) => b.scope_kind === 'scan').length} scan-scoped limits
              exist. Each belongs to one scan and is shown on that scan's record.
            </p>
          </>
        ) : budgets.status === 'error' ? (
          <ErrorPanel error={budgets.error} onRetry={budgets.reload} />
        ) : (
          <Loading label="Loading cost limits" lines={3} />
        )}
        {session.role !== 'owner' ? (
          <p
            style={{
              marginTop: 'var(--s4)',
              fontSize: 'var(--text-meta)',
              color: 'var(--ink-secondary)',
            }}
          >
            Changing a limit requires the owner role.
          </p>
        ) : null}
      </div>

      <div className="panel">
        <h2>Adapters</h2>
        <AdapterInventory />
      </div>

      <div className="panel">
        <h2>Not available in this build</h2>
        <ul style={{ margin: 0, paddingInlineStart: 'var(--s5)', color: 'var(--ink-secondary)' }}>
          <li>
            Public intake of customer-requested scans — a later milestone with its own abuse
            controls.
          </li>
          <li>
            Commerce integrations — none is connected, and none can be enabled from this screen.
          </li>
          <li>Outbound messaging of any kind — deliberately absent, not merely switched off.</li>
          <li>Customer billing — the ledger here is internal cost control only.</li>
          <li>Detectors beyond MF-LINK-01 — specified, not implemented.</li>
        </ul>
      </div>
    </>
  );
}

/**
 * Readiness lives outside `/v1` because it must answer before a session exists, so it is
 * fetched directly. It is a configuration check: no provider is contacted and no money is
 * spent to produce it.
 */
function AdapterInventory() {
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState<{ nonce: number; readiness: Readiness } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/ready', { credentials: 'same-origin' })
      .then((response) => response.json())
      .then((readiness: Readiness) => {
        if (!cancelled) setSettled({ nonce, readiness });
      })
      .catch(() => {
        if (cancelled) return;
        setSettled({
          nonce,
          readiness: { status: 'not_ready', environment: 'unknown', missing_bindings: ['API'] },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const recheck = useCallback(() => setNonce((value) => value + 1), []);
  const state = settled && settled.nonce === nonce ? settled.readiness : null;

  if (!state) return <Loading label="Checking adapter readiness" lines={2} />;

  return (
    <>
      {state.missing_bindings.length > 0 ? (
        <Notice tone="attention" title="Some bindings are not configured">
          <p>
            {state.missing_bindings.join(', ')}. Requests that need them fail with a specific reason
            rather than returning sample data.
          </p>
        </Notice>
      ) : (
        <Notice tone="confirmed" title="All required bindings are present">
          <p>
            Readiness checks configuration only. It does not contact a provider or spend money, so
            it cannot prove a live capture would succeed.
          </p>
        </Notice>
      )}
      <p
        style={{
          marginTop: 'var(--s4)',
          fontSize: 'var(--text-meta)',
          color: 'var(--ink-secondary)',
          display: 'flex',
          gap: 'var(--s3)',
          alignItems: 'center',
        }}
      >
        Environment: <code>{state.environment}</code>
        <button type="button" className="btn" style={{ minHeight: 32 }} onClick={recheck}>
          Re-check
        </button>
      </p>
    </>
  );
}
