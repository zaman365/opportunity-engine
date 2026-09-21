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

/**
 * The engagement lifecycle, from WORKFLOWS.md.
 *
 * Kept out of `MACHINES` on purpose. That table is asserted edge-for-edge against the kit's
 * `contracts/state-machines.json`, which declares three machines; adding a fourth there would
 * either break the parity test or require editing the handoff. Same trade-off as the contract
 * overlay (ADR-018), same resolution: the handoff stays byte-identical and this repository
 * adds its own, labelled as its own.
 *
 * WORKFLOWS.md: "No start before accepted offer version, required permissions and
 * payment/contract prerequisites. Acceptance follows verified work plus customer/authorized
 * owner acceptance, not a 'payment succeeded' webhook. Scope change creates a new approved
 * version." The last of those is why `change_requested` leads back to `draft` rather than
 * onward: a changed scope is a new thing to accept, not an amendment to one already accepted.
 */
export const ENGAGEMENT_MACHINE = {
  draft: ['awaiting_acceptance', 'cancelled'],
  // The customer has the quote. Nothing starts until they say yes.
  awaiting_acceptance: ['awaiting_prerequisites', 'ready', 'change_requested', 'cancelled'],
  // Accepted, but something the work depends on is not in place yet.
  awaiting_prerequisites: ['ready', 'change_requested', 'cancelled'],
  ready: ['in_progress', 'change_requested', 'cancelled'],
  in_progress: ['awaiting_verification', 'change_requested', 'disputed', 'cancelled'],
  // Verification can send work back. An acceptance test that failed is not a dispute.
  awaiting_verification: ['accepted', 'in_progress', 'change_requested', 'disputed'],
  accepted: ['closed', 'disputed'],
  // A changed scope is a new quote to accept, not an amendment to an accepted one.
  change_requested: ['draft', 'cancelled'],
  disputed: ['in_progress', 'cancelled', 'closed'],
  cancelled: [],
  closed: [],
} as const satisfies Record<string, readonly string[]>;

/**
 * What `transition` will judge: the handoff's three machines plus this repository's one.
 *
 * Merged here rather than at each call site, so a new machine cannot be half-adopted.
 */
export const ALL_MACHINES = {
  ...MACHINES,
  engagement: ENGAGEMENT_MACHINE,
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type MachineKind = keyof typeof ALL_MACHINES;

export type TransitionErrorCode =
  'INVALID_STATE' | 'INVALID_VERSION' | 'VERSION_CONFLICT' | 'INVALID_TRANSITION';

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
  const machine = (ALL_MACHINES as Record<string, Record<string, readonly string[]>>)[kind];
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
  const machine = ALL_MACHINES[kind] as Record<string, readonly string[]>;
  return Object.hasOwn(machine, state) && machine[state]!.length === 0;
}
