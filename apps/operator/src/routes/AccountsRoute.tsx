import type { Accounts, Session } from '@oe/contracts';
import { useResource } from '../api/hooks.ts';
import { EmptyState, ErrorPanel, Loading, Timestamp } from '../components/primitives.tsx';

/**
 * Accounts and their approved host policy.
 *
 * The approved host list is the boundary every scan is checked against, so it is shown
 * plainly rather than hidden in a settings dialog. Only an owner can change it, and this
 * milestone has no editing surface for it yet — saying so is better than a dead button.
 */
export function AccountsRoute({ session }: { session: Session }) {
  const resource = useResource<Accounts>('/accounts?limit=100');

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Accounts</h1>
          <p>
            A business plus the exact hosts an owner has approved for inspection. An operator
            cannot widen this list.
          </p>
        </div>
      </div>

      {resource.status === 'loading' ? <Loading label="Loading accounts" lines={4} /> : null}
      {resource.status === 'error' ? <ErrorPanel error={resource.error} onRetry={resource.reload} /> : null}

      {resource.status === 'ready' && resource.data.items.length === 0 ? (
        <EmptyState kind="workspace" title="No accounts yet">
          An owner records an account with its canonical domain, the hosts approved for
          inspection and where that approval came from.
        </EmptyState>
      ) : null}

      {resource.status === 'ready' && resource.data.items.length > 0 ? (
        <ul className="caselist">
          {resource.data.items.map((account) => (
            <li key={account.id} className="caserow">
              <span className="docket">v{account.version}</span>
              <span className="title">
                <strong style={{ fontSize: 'var(--text-lead)' }}>{account.name}</strong>
                <span className="account">{account.canonical_domain}</span>
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-meta)', overflowWrap: 'anywhere' }}>
                {account.approved_hosts.join(', ')}
              </span>
              <span className="score">
                <b>approved hosts</b>
                {account.approved_hosts.length}
              </span>
              <span className="score">
                <b>added</b>
                <Timestamp value={account.created_at} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {session.role === 'owner' ? (
        <p style={{ marginTop: 'var(--s5)', color: 'var(--ink-secondary)', fontSize: 'var(--text-meta)' }}>
          Creating an account and recording its scan authorization are owner API operations.
          A form for them is not built in this milestone.
        </p>
      ) : null}
    </>
  );
}
