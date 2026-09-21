import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Accounts, Budgets, Scan, Session } from '@oe/contracts';
import { ApiError, NetworkError, command, get, newIdempotencyKey } from '../api/client.ts';
import { useResource } from '../api/hooks.ts';
import { ErrorPanel, Loading, Money, Notice } from '../components/primitives.tsx';

interface AuthorizationOption {
  id: string;
  account_id: string;
  action: string;
  expires_at: string;
  revoked_at: string | null;
}

/**
 * New scan.
 *
 * UI_SPEC.md: "What exactly will be checked and what can it cost?" The form states the
 * bounded scope and the cap before the confirm action, names the specific missing
 * prerequisite when confirmation is impossible, and never offers a submit that cannot work.
 *
 * The idempotency key is generated once per form instance, so a double click or a retry
 * after a timeout is the same operation rather than a second scan.
 */
export function NewScanRoute({ session }: { session: Session }) {
  const navigate = useNavigate();
  const accounts = useResource<Accounts>('/accounts?limit=100');
  const budgets = useResource<Budgets>('/budgets');

  const [accountId, setAccountId] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [maxPages, setMaxPages] = useState(2);
  const [capMicro, setCapMicro] = useState('100000');
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(newIdempotencyKey());

  const account = accounts.data?.items.find((item) => item.id === accountId) ?? null;

  const ledgerCurrency = budgets.data?.items[0]?.currency ?? 'USD';
  const pausedScope = budgets.data?.items.find((b) => b.paused && b.scope_kind !== 'scan') ?? null;

  const urlProblem = useMemo(() => {
    if (!targetUrl.trim()) return 'Enter the page to inspect.';
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return 'That is not a complete URL.';
    }
    if (!account) return null;
    const authority = parsed.host.toLowerCase();
    if (!account.approved_hosts.map((h) => h.toLowerCase()).includes(authority)) {
      return `${authority} is not an approved host for this account. An owner must approve it first.`;
    }
    return null;
  }, [targetUrl, account]);

  const blocker = !account
    ? 'Select an approved account.'
    : urlProblem
      ? urlProblem
      : pausedScope
        ? `The ${pausedScope.scope_kind} cost limit is paused. An owner must resume it before new work can start.`
        : session.role === 'viewer'
          ? 'Your membership does not include the operator role.'
          : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (blocker || !account) return;
    setBusy(true);
    setError(null);
    try {
      const authorizationId = await resolveAuthorization(account.id);
      const scan = await command<Scan>(
        '/scans',
        {
          account_id: account.id,
          venture_id: account.venture_id,
          target_url: targetUrl.trim(),
          authorization_id: authorizationId,
          max_unique_pages: maxPages,
          detectors: ['MF-LINK-01'],
          max_cost: { currency: ledgerCurrency, amount_micro: capMicro },
        },
        { idempotencyKey: idempotencyKey.current },
      );
      navigate(`/scans/${scan.id}`);
    } catch (caught) {
      if (caught instanceof ApiError || caught instanceof NetworkError) setError(caught);
      else setError(new NetworkError('The scan could not be submitted.'));
    } finally {
      setBusy(false);
    }
  }

  if (accounts.status === 'loading' || budgets.status === 'loading') {
    return <Loading label="Loading approved accounts and cost limits" lines={4} />;
  }
  if (accounts.status === 'error') return <ErrorPanel error={accounts.error} onRetry={accounts.reload} />;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>New scan</h1>
          <p>
            One approved page plus the information pages linked from it, checked twice in
            independent sessions. This is a sample, not a whole-store inspection.
          </p>
        </div>
      </div>

      {error ? <ErrorPanel error={error} /> : null}

      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="account">Approved account</label>
          <select
            id="account"
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
              setError(null);
            }}
            required
          >
            <option value="">Select an account</option>
            {accounts.data.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} — {item.canonical_domain}
              </option>
            ))}
          </select>
          <p className="help">
            {account
              ? `Approved hosts: ${account.approved_hosts.join(', ')}. Only these can be inspected.`
              : 'The account carries the approved host list. An operator cannot widen it.'}
          </p>
        </div>

        <div className="field">
          <label htmlFor="target">Page to inspect</label>
          <input
            id="target"
            type="text"
            inputMode="url"
            value={targetUrl}
            onChange={(event) => setTargetUrl(event.target.value)}
            placeholder={account ? `https://${account.approved_hosts[0]}/product` : 'https://…'}
            aria-invalid={Boolean(urlProblem && targetUrl.trim())}
            aria-describedby={urlProblem ? 'target-error' : undefined}
            required
          />
          {urlProblem && targetUrl.trim() ? (
            <p id="target-error" role="alert">
              {urlProblem}
            </p>
          ) : (
            <p className="help">
              Cart, checkout, account and logout paths are never opened, and a URL carrying a
              token-like parameter is refused.
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="pages">Page limit</label>
          <input
            id="pages"
            type="number"
            min={1}
            max={5}
            value={maxPages}
            onChange={(event) => setMaxPages(Number(event.target.value))}
          />
          <p className="help">
            At most five unique pages. Re-checking a page in a second clean session does not
            count twice.
          </p>
        </div>

        <div className="field">
          <label htmlFor="cap">Total scan limit</label>
          <div className="amount">
            <input
              id="cap"
              type="text"
              inputMode="numeric"
              value={capMicro}
              onChange={(event) => setCapMicro(event.target.value.replace(/[^0-9]/g, ''))}
              style={{ maxWidth: 200 }}
            />
            <span className="currency">{ledgerCurrency} micro-units</span>
          </div>
          <p className="help">
            <Money currency={ledgerCurrency} amountMicro={capMicro || '0'} /> · this is a
            ceiling you authorise, not a price. Workspace and venture limits still apply on
            top of it.
          </p>
        </div>

        {blocker ? (
          <Notice tone="attention" title="This scan cannot start yet">
            <p>{blocker}</p>
          </Notice>
        ) : null}

        <div style={{ display: 'flex', gap: 'var(--s3)', flexWrap: 'wrap' }}>
          <button
            type="submit"
            className="btn"
            data-variant="primary"
            disabled={Boolean(blocker) || busy}
            title={blocker ?? 'Admit this bounded scan.'}
          >
            {busy ? 'Submitting…' : 'Confirm bounded scan'}
          </button>
          <button type="button" className="btn" onClick={() => navigate(-1)} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}

/**
 * Find the account's current scan authorization.
 *
 * Authorizations are owner-created records with their own purpose and expiry; the operator
 * does not choose one, and a missing or expired record is a refusal rather than a default.
 */
async function resolveAuthorization(accountId: string): Promise<string> {
  const response = await get<{ items: AuthorizationOption[] }>(
    `/accounts/${accountId}/authorizations`,
  ).catch(() => null);
  const usable = response?.items.find(
    (item) =>
      item.action === 'scan_public' &&
      item.revoked_at === null &&
      Date.parse(item.expires_at) > Date.now(),
  );
  if (!usable) {
    throw new ApiError({
      type: 'about:blank',
      title: 'No current scan authorization',
      status: 422,
      code: 'AUTHORIZATION_EXPIRED',
      detail:
        'This account has no current authorization to scan. An owner must record one, with its purpose and expiry, first.',
      request_id: 'client',
      retryable: false,
    });
  }
  return usable.id;
}
