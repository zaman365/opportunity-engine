/**
 * Allowed state edges, mirrored from `contracts/state-machines.json`.
 *
 * `test/reference-parity.test.ts` asserts this table is edge-for-edge identical to the
 * contract file, so the two cannot drift. Transitions here are a shape guard only:
 * authorisation, invariants and persistence are separate mandatory gates.
 */

export const MACHINES = {
  scan: {
    queued: ['validating', 'blocked', 'cancel_requested', 'failed'],
    validating: ['capturing', 'blocked', 'cancel_requested', 'failed'],
    capturing: ['analysing', 'partial', 'blocked', 'cancel_requested', 'failed'],
    analysing: ['succeeded', 'partial', 'blocked', 'cancel_requested', 'failed'],
    cancel_requested: ['cancelled'],
    succeeded: [],
    partial: [],
    blocked: [],
    failed: [],
    cancelled: [],
  },
  finding: {
    candidate: ['confirmed', 'rejected', 'unknown'],
    unknown: ['candidate'],
    confirmed: ['stale', 'rejected'],
    stale: ['candidate', 'rejected'],
    rejected: [],
  },
  report: {
    draft: ['approved', 'superseded'],
    approved: ['published', 'superseded'],
    published: ['revoked', 'superseded'],
    revoked: [],
    superseded: [],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type MachineKind = keyof typeof MACHINES;

export type TransitionErrorCode =
  | 'INVALID_STATE'
  | 'INVALID_VERSION'
  | 'VERSION_CONFLICT'
  | 'INVALID_TRANSITION';

export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TransitionError';
  }
}

export interface TransitionInput {
  kind: string;
  state: string;
  version: number;
  expectedVersion: number;
  next: string;
}

export function transition({ kind, state, version, expectedVersion, next }: TransitionInput): {
  kind: string;
  state: string;
  version: number;
} {
  const machine = (MACHINES as Record<string, Record<string, readonly string[]>>)[kind];
  if (!machine || !Object.hasOwn(machine, state) || !Object.hasOwn(machine, next)) {
    throw new TransitionError('INVALID_STATE', 'Unknown machine or state.');
  }
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    throw new TransitionError('INVALID_VERSION', 'Positive integer versions are required.');
  }
  if (version !== expectedVersion) {
    throw new TransitionError('VERSION_CONFLICT', 'Reload and re-review the current version.');
  }
  if (!machine[state]!.includes(next)) {
    throw new TransitionError('INVALID_TRANSITION', `${state} cannot transition to ${next}.`);
  }
  return { kind, state: next, version: version + 1 };
}

/** Terminal states never restart in place; a rerun creates a new aggregate. */
export function isTerminal(kind: MachineKind, state: string): boolean {
  const machine = MACHINES[kind] as Record<string, readonly string[]>;
  return Object.hasOwn(machine, state) && machine[state]!.length === 0;
}
