import type { Problem, Session } from '@oe/contracts';

/**
 * Typed API client.
 *
 * Every unsafe request carries the session CSRF token and an Idempotency-Key, and a network
 * failure never causes a silent retry: `API_GUIDE.md` warns that a timeout is not proof that
 * an operation was not admitted, so a retry reuses the original key.
 */

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail);
    this.name = 'ApiError';
  }

  get code(): string {
    return this.problem.code;
  }
  get status(): number {
    return this.problem.status;
  }
}

/** A failure that never reached the server, so the operation's fate is unknown. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

let session: Session | null = null;

/** The local fixture identity, supplied by the dev shell. Absent in a deployed build. */
function fixtureSubject(): string | null {
  const stored = globalThis.localStorage?.getItem('oe.fixtureSubject');
  return stored && stored.trim() ? stored.trim() : null;
}

export function setFixtureSubject(subject: string): void {
  globalThis.localStorage?.setItem('oe.fixtureSubject', subject);
  session = null;
}

export function currentSession(): Session | null {
  return session;
}

function baseHeaders(): Headers {
  const headers = new Headers({ accept: 'application/json' });
  const subject = fixtureSubject();
  // Only meaningful against a local fixture-auth API; a deployed build ignores it and the
  // Access session cookie is what authenticates.
  if (subject) headers.set('x-fixture-subject', subject);
  return headers;
}

async function parse<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  let problem: Problem;
  try {
    problem = (await response.json()) as Problem;
  } catch {
    problem = {
      type: 'about:blank',
      title: 'Unexpected response',
      status: response.status,
      code: 'DEPENDENCY_UNAVAILABLE',
      detail: 'The API returned a response this client could not read.',
      request_id: response.headers.get('x-request-id') ?? 'unknown',
      retryable: false,
    };
  }
  throw new ApiError(problem);
}

export async function get<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      method: 'GET',
      headers: baseHeaders(),
      credentials: 'same-origin',
    });
  } catch (error) {
    throw new NetworkError(error instanceof Error ? error.message : 'Request failed');
  }
  return parse<T>(response);
}

export interface CommandOptions {
  method?: 'POST' | 'PATCH';
  /** Reused verbatim on a retry so a timed-out request cannot create a second operation. */
  idempotencyKey: string;
}

export async function command<T>(path: string, body: unknown, options: CommandOptions): Promise<T> {
  if (!session) await loadSession();
  const headers = baseHeaders();
  headers.set('content-type', 'application/json');
  headers.set('x-csrf-token', session!.csrf_token);
  headers.set('idempotency-key', options.idempotencyKey);

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new NetworkError(error instanceof Error ? error.message : 'Request failed');
  }
  return parse<T>(response);
}

export async function loadSession(): Promise<Session> {
  session = await get<Session>('/session');
  return session;
}

/** Stable key for one user intent, so an accidental double submit is one operation. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export function evidenceContentUrl(evidenceId: string): string {
  return `/api/v1/evidence/${evidenceId}/content`;
}
