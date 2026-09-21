/** Pure state transition helper, NOT a durable workflow or authorization gate. */
import { readFileSync } from 'node:fs';
export const MACHINES = JSON.parse(readFileSync(new URL('../contracts/state-machines.json', import.meta.url))).machines;
export class TransitionError extends Error { constructor(code, message) { super(message); this.code=code; } }
export function transition({ kind, state, version, expectedVersion, next }) {
  const machine=MACHINES[kind];
  if (!machine || !Object.hasOwn(machine,state) || !Object.hasOwn(machine,next))
    throw new TransitionError('INVALID_STATE','Unknown machine or state.');
  if (!Number.isSafeInteger(version)||version<1||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)
    throw new TransitionError('INVALID_VERSION','Positive integer versions are required.');
  if (version!==expectedVersion) throw new TransitionError('VERSION_CONFLICT','Reload and re-review the current version.');
  if (!machine[state].includes(next)) throw new TransitionError('INVALID_TRANSITION',`${state} cannot transition to ${next}.`);
  return {kind,state:next,version:version+1};
}
