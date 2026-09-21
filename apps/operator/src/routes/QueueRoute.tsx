import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Opportunities, Opportunity, Session } from '@oe/contracts';
import { useDebounced, useResource } from '../api/hooks.ts';
import { Chip, EmptyState, ErrorPanel, Loading, Timestamp } from '../components/primitives.tsx';

/**
 * The review queue.
 *
 * UI_SPEC.md: "The default sort considers actionable/fresh/reviewable work, not simply
 * descending score. Show unknown score as an interval or 'Not scored,' never 0%."
 *
 * Row activation is a real link with a name, so keyboard and middle-click behave normally
 * and no hidden nested button competes with a whole-row click target.
 */
export function QueueRoute({ session }: { session: Session }) {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const debounced = useDebounced(query, 150);
  const filter = (params.get('state') ?? 'actionable') as FilterKey;

  const resource = useResource<Opportunities>('/opportunities?limit=100');

  const filtered = useMemo(() => {
    const items = resource.data?.items ?? [];
    const searched = debounced.trim()
      ? items.filter((item) => matches(item, debounced.trim().toLowerCase()))
      : items;
    return sortForReview(searched.filter((item) => FILTERS[filter].predicate(item)));
  }, [resource.data, debounced, filter]);

  function setFilter(next: FilterKey) {
    const updated = new URLSearchParams(params);
    updated.set('state', next);
    setParams(updated, { replace: true });
  }

  function setQueryParam(value: string) {
    setQuery(value);
    const updated = new URLSearchParams(params);
    if (value.trim()) updated.set('q', value);
    else updated.delete('q');
    setParams(updated, { replace: true });
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Review queue</h1>
          <p>
            What needs a decision next. Each case is one account, one supported observation
            and the evidence recorded for it.
          </p>
        </div>
        {session.role === 'viewer' ? null : (
          <Link className="btn" data-variant="primary" to="/scans/new">
            New scan
          </Link>
        )}
      </div>

      <div className="queue-controls">
        <input
          type="search"
          value={query}
          onChange={(event) => setQueryParam(event.target.value)}
          placeholder="Find an account or observation"
          aria-label="Find an account or observation"
        />
        <div className="filterset" role="group" aria-label="Filter cases">
          {(Object.keys(FILTERS) as FilterKey[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {FILTERS[key].label}
            </button>
          ))}
        </div>
      </div>

      {resource.status === 'loading' ? <Loading label="Loading the review queue" lines={5} /> : null}
      {resource.status === 'error' ? (
        <ErrorPanel error={resource.error} onRetry={resource.reload} />
      ) : null}

      {resource.status === 'ready' && resource.data.items.length === 0 ? (
        <EmptyState
          kind="workspace"
          title="No scans yet"
          action={
            session.role === 'viewer' ? undefined : (
              <Link className="btn" data-variant="primary" to="/scans/new">
                Create an approved scan
              </Link>
            )
          }
        >
          A scan inspects one approved page and up to a few pages linked from it, then
          records what it observed. Nothing appears here until a scan has run.
        </EmptyState>
      ) : null}

      {resource.status === 'ready' && resource.data.items.length > 0 && filtered.length === 0 ? (
        <EmptyState
          kind="filters"
          title="No cases match these filters"
          action={
            <button
              type="button"
              className="btn"
              onClick={() => {
                setQueryParam('');
                setFilter('all');
              }}
            >
              Clear filters
            </button>
          }
        >
          {resource.data.items.length} case{resource.data.items.length === 1 ? '' : 's'} exist in
          this workspace, but none match “{debounced}” with the {FILTERS[filter].label.toLowerCase()}{' '}
          filter.
        </EmptyState>
      ) : null}

      {filtered.length > 0 ? (
        <ul className="caselist">
          {filtered.map((item) => (
            <CaseRow key={item.id} opportunity={item} />
          ))}
        </ul>
      ) : null}
    </>
  );
}

function CaseRow({ opportunity }: { opportunity: Opportunity }) {
  const priority = opportunity.priority;
  return (
    <li className="caserow">
      <span className="docket">{docketOf(opportunity.id)}</span>
      <span className="title">
        <Link to={`/opportunities/${opportunity.id}`}>{opportunity.title}</Link>
        <span className="account">
          {opportunity.account.name} · {opportunity.account.canonical_domain}
        </span>
      </span>
      <span className="permission">
        <Chip tone={permissionTone(opportunity.permission_state)}>
          {opportunity.permission_state.replaceAll('_', ' ')}
        </Chip>
      </span>
      <span className="score">
        {priority === null ? (
          <b>Not scored</b>
        ) : priority.pointScore !== null ? (
          <>
            <b>{priority.pointScore.toFixed(1)}</b>
            complete inputs
          </>
        ) : (
          <>
            {/* An unknown input is shown as an interval, never redistributed or zeroed. */}
            <b>
              {priority.lowerBound.toFixed(0)}–{priority.upperBound.toFixed(0)}
            </b>
            {Math.round(priority.weightedCoverage * 100)}% of inputs known
          </>
        )}
      </span>
      <span className="score">
        <b>{nextActionLabel(opportunity.next_action)}</b>
        <Timestamp value={opportunity.updated_at} />
      </span>
    </li>
  );
}

type FilterKey = 'actionable' | 'blocked' | 'all';

const FILTERS: Record<FilterKey, { label: string; predicate: (o: Opportunity) => boolean }> = {
  actionable: {
    label: 'Ready to review',
    predicate: (o) => o.next_action === 'review_evidence' && o.permission_state !== 'blocked',
  },
  blocked: {
    label: 'Blocked',
    predicate: (o) => o.permission_state === 'blocked' || o.next_action === 'request_access',
  },
  all: { label: 'All', predicate: () => true },
};

/**
 * Actionable and fresh first, then everything else. A high but unscorable case does not
 * outrank a reviewable one just because its upper bound is large.
 */
function sortForReview(items: Opportunity[]): Opportunity[] {
  const rank = (o: Opportunity) => {
    if (o.next_action === 'review_evidence') return 0;
    if (o.next_action === 'revalidate') return 1;
    if (o.next_action === 'draft_offer') return 2;
    if (o.next_action === 'request_access') return 3;
    return 4;
  };
  return [...items].sort((a, b) => {
    const byAction = rank(a) - rank(b);
    if (byAction !== 0) return byAction;
    return Date.parse(b.updated_at) - Date.parse(a.updated_at);
  });
}

function matches(opportunity: Opportunity, needle: string): boolean {
  return (
    opportunity.title.toLowerCase().includes(needle) ||
    opportunity.account.name.toLowerCase().includes(needle) ||
    opportunity.account.canonical_domain.toLowerCase().includes(needle) ||
    docketOf(opportunity.id).toLowerCase().includes(needle)
  );
}

function permissionTone(state: Opportunity['permission_state']) {
  if (state === 'action_allowed') return 'confirmed' as const;
  if (state === 'blocked') return 'blocked' as const;
  if (state === 'review_allowed') return 'attention' as const;
  return 'unknown' as const;
}

function nextActionLabel(action: Opportunity['next_action']): string {
  switch (action) {
    case 'review_evidence':
      return 'Review evidence';
    case 'request_access':
      return 'Request access';
    case 'revalidate':
      return 'Revalidate';
    case 'draft_offer':
      return 'Draft scope';
    default:
      return 'No action';
  }
}

/**
 * A short, stable case identifier that carries from queue to evidence to report.
 * Derived from the id so it needs no extra column and never collides within a workspace.
 */
export function docketOf(id: string): string {
  return `OE-${id.replace(/-/g, '').slice(-6).toUpperCase()}`;
}
