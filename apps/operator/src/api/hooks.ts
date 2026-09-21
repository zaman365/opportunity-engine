import { useCallback, useEffect, useState } from 'react';
import { ApiError, NetworkError, get } from './client.ts';

/**
 * A small resource hook. No data-fetching library: the operator has a handful of endpoints,
 * and an explicit state machine keeps "loading", "blocked" and "failed" distinguishable,
 * which UI_SPEC.md requires them to be.
 *
 * Each settled result records the request key it belongs to. Loading is therefore *derived*
 * — the stored key does not match the current one — rather than written by an effect, so a
 * late response for a previous path can never be shown as the current one.
 */

export type ResourceState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: ApiError | NetworkError };

/** A discriminated union plus a reload handle; narrowing on `status` still works. */
export type Resource<T> = ResourceState<T> & { reload: () => void };

const LOADING = { status: 'loading', data: null, error: null } as const;

export function useResource<T>(path: string | null, deps: unknown[] = []): Resource<T> {
  const [nonce, setNonce] = useState(0);
  const key = `${path ?? 'idle'}|${nonce}|${JSON.stringify(deps)}`;
  const [settled, setSettled] = useState<{ key: string; state: ResourceState<T> } | null>(null);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    get<T>(path)
      .then((data) => {
        if (!cancelled) setSettled({ key, state: { status: 'ready', data, error: null } });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const failure =
          error instanceof ApiError || error instanceof NetworkError
            ? error
            : new NetworkError('The request failed for an unexpected reason.');
        setSettled({ key, state: { status: 'error', data: null, error: failure } });
      });
    return () => {
      cancelled = true;
    };
  }, [key, path]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const state = settled && settled.key === key ? settled.state : LOADING;
  return { ...state, reload } as Resource<T>;
}

/** Polls while `active` stays true. Used for a scan that is still running. */
export function usePolling(active: boolean, reload: () => void, intervalMs = 1500): void {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, intervalMs);
    return () => clearInterval(timer);
  }, [active, reload, intervalMs]);
}

/** Debounce a fast-changing value, for a search box that filters a list. */
export function useDebounced<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * A clock sampled on an interval.
 *
 * Freshness and retention are time-dependent, and reading the clock during render would be
 * impure. Sampling it means an artifact that passes its retention date while someone is
 * looking at it becomes unavailable on its own, which is the behaviour the retention policy
 * describes.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
