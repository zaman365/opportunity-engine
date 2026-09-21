import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import type { Session } from '@oe/contracts';
import { ApiError, NetworkError, loadSession, setFixtureSubject } from './api/client.ts';
import { ErrorPanel, Loading } from './components/primitives.tsx';
import { QueueRoute } from './routes/QueueRoute.tsx';
import { CaseRoute } from './routes/CaseRoute.tsx';
import { ScansRoute } from './routes/ScansRoute.tsx';
import { ScanDetailRoute } from './routes/ScanDetailRoute.tsx';
import { NewScanRoute } from './routes/NewScanRoute.tsx';
import { AccountsRoute } from './routes/AccountsRoute.tsx';
import { ReportRoute } from './routes/ReportRoute.tsx';
import { SettingsRoute } from './routes/SettingsRoute.tsx';
import { DesignStudiesRoute } from './routes/DesignStudiesRoute.tsx';

/**
 * Application shell.
 *
 * UI_SPEC.md: "Do not create an unnecessary 'dashboard' between sign-in and useful work.
 * Initial destination is the actionable queue or honest empty state." There is no landing
 * page here — `/` is the review queue.
 *
 * Only surfaces that work in this milestone appear in the navigation. `/engagements` (M3)
 * and `/monitoring` (M5) are deliberately absent rather than present and dead.
 */
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const location = useLocation();

  useEffect(() => {
    loadSession()
      .then(setSession)
      .catch((caught: unknown) => {
        if (caught instanceof ApiError || caught instanceof NetworkError) setError(caught);
        else setError(new NetworkError('The workspace could not be loaded.'));
      });
  }, []);

  useEffect(() => {
    document.title = `${titleFor(location.pathname)} · Opportunity Engine`;
  }, [location.pathname]);

  if (error) {
    return (
      <div className="shell">
        <main>
          <SignInHelp error={error} />
        </main>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="shell">
        <main>
          <Loading label="Loading your workspace" />
        </main>
      </div>
    );
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>

      {/* The environment banner is not decoration: it is how an operator knows whether the
          data in front of them is synthetic. */}
      <div className="envbar" data-environment={session.environment}>
        <span>
          {session.environment === 'local'
            ? 'Local development · synthetic fixtures · no live scans'
            : `${session.environment} environment`}
        </span>
        <span>MF-LINK-01 only · other detectors not enabled</span>
      </div>

      <header className="topbar">
        <div className="wordmark">
          oe<span>Opportunity Engine</span>
        </div>
        <nav className="nav" aria-label="Primary">
          <NavLink to="/opportunities">Review queue</NavLink>
          <NavLink to="/scans">Scans</NavLink>
          <NavLink to="/accounts">Accounts</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="workspace">
          <dl>
            <div>
              <dt>Workspace</dt>
              <dd>{session.active_tenant_id.slice(0, 8)}</dd>
            </div>
            <div>
              <dt>Signed in</dt>
              <dd>{session.subject}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{session.role}</dd>
            </div>
          </dl>
        </div>
      </header>

      <main id="content">
        <Routes>
          <Route path="/" element={<QueueRoute session={session} />} />
          <Route path="/opportunities" element={<QueueRoute session={session} />} />
          <Route path="/opportunities/:id" element={<CaseRoute session={session} />} />
          <Route path="/scans" element={<ScansRoute />} />
          <Route path="/scans/new" element={<NewScanRoute session={session} />} />
          <Route path="/scans/:id" element={<ScanDetailRoute session={session} />} />
          <Route path="/accounts" element={<AccountsRoute session={session} />} />
          <Route path="/reports/:id" element={<ReportRoute session={session} />} />
          <Route path="/settings" element={<SettingsRoute session={session} />} />
          <Route path="/design-studies" element={<DesignStudiesRoute />} />
          <Route
            path="*"
            element={
              <div className="empty">
                <h2>No such page</h2>
                <p>Use the review queue to find work.</p>
              </div>
            }
          />
        </Routes>
      </main>
    </div>
  );
}

function titleFor(pathname: string): string {
  if (pathname.startsWith('/scans')) return 'Scans';
  if (pathname.startsWith('/accounts')) return 'Accounts';
  if (pathname.startsWith('/reports')) return 'Report';
  if (pathname.startsWith('/settings')) return 'Settings';
  if (pathname.startsWith('/design-studies')) return 'Design studies';
  return 'Review queue';
}

/**
 * In a local build the identity comes from a header, so the shell offers the fixture
 * identities explicitly rather than pretending a sign-in screen exists. A deployed build
 * never reaches this component with a fixture hint, because the API rejects that mode.
 */
function SignInHelp({ error }: { error: ApiError | NetworkError }) {
  const subjects = [
    'owner@fixture.test',
    'operator@fixture.test',
    'reviewer@fixture.test',
    'viewer@fixture.test',
  ];
  const isAuth = error instanceof ApiError && (error.status === 401 || error.status === 403);
  return (
    <div className="panel" style={{ maxWidth: 640, margin: '10vh auto' }}>
      <h2>Workspace unavailable</h2>
      <ErrorPanel error={error} onRetry={() => window.location.reload()} />
      {isAuth ? (
        <div style={{ marginTop: 'var(--s6)' }}>
          <p style={{ color: 'var(--ink-secondary)' }}>
            This local build resolves identity from a fixture header. Pick one of the seeded
            test identities; role and workspace still come from the database, not from this
            choice.
          </p>
          <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap', marginTop: 'var(--s4)' }}>
            {subjects.map((subject) => (
              <button
                key={subject}
                type="button"
                className="btn"
                onClick={() => {
                  setFixtureSubject(subject);
                  window.location.reload();
                }}
              >
                {subject}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
