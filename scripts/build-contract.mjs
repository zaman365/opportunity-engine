#!/usr/bin/env node
/**
 * Generate the served API contract from the build kit's M1 document plus an overlay.
 *
 * AGENTS.md requires machine contracts to be updated in the same change as the code, and
 * API_GUIDE.md says later milestones "require those contracts to be added alongside
 * implementations". But the kit is a handoff artifact whose integrity is recorded in
 * SHA256SUMS, so editing it in place would quietly break that record.
 *
 * So the kit's document stays byte-identical and is the *base*. `contracts/overlay.json`
 * states each M2 change as one JSON-Pointer assignment with a written reason, and this script
 * applies them. `tests/contract/generated-contract.test.ts` then asserts that regeneration is
 * deterministic, that every M1 operation and role survived, and that the changes only widen
 * what the contract accepts.
 *
 * Run with `--check` in CI to fail when the committed file is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function buildContract() {
  const overlay = JSON.parse(readFileSync(resolve(root, 'contracts/overlay.json'), 'utf8'));
  const base = JSON.parse(readFileSync(resolve(root, overlay.base), 'utf8'));

  for (const change of overlay.changes) {
    if (change.op !== 'set' && change.op !== 'add') {
      throw new Error(`Unsupported overlay op: ${change.op}`);
    }
    setPointer(base, change.pointer, change.value, change.op);
  }
  return base;
}

/**
 * RFC 6901 pointer assignment.
 *
 * `set` requires the target to exist, so a typo in a pointer fails loudly instead of
 * inventing a property the base never had. `add` requires the *parent* to exist and the leaf
 * to be absent, which is the only way to introduce something genuinely new.
 */
function setPointer(document, pointer, value, op) {
  const tokens = pointer
    .split('/')
    .slice(1)
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  const last = tokens.pop();
  if (last === undefined) throw new Error('Pointer must name a property.');

  let target = document;
  for (const token of tokens) {
    if (target === null || typeof target !== 'object' || !(token in target)) {
      throw new Error(`Overlay pointer ${pointer} does not exist in the base document.`);
    }
    target = target[token];
  }
  if (op === 'set' && !(last in target)) {
    throw new Error(`Overlay "set" pointer ${pointer} does not exist in the base document.`);
  }
  if (op === 'add' && last in target) {
    throw new Error(`Overlay "add" pointer ${pointer} already exists; use "set" to replace it.`);
  }
  target[last] = value;
}

export const OUTPUT_PATH = resolve(root, 'contracts/openapi.json');

export function serialise(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

const invokedDirectly = process.argv[1]?.endsWith('build-contract.mjs');
if (invokedDirectly) {
  const generated = serialise(buildContract());
  if (process.argv.includes('--check')) {
    const committed = readFileSync(OUTPUT_PATH, 'utf8');
    if (committed !== generated) {
      process.stderr.write(
        'contracts/openapi.json is stale. Run `npm run contract:build` and commit the result.\n',
      );
      process.exit(1);
    }
    process.stdout.write('contracts/openapi.json matches the overlay.\n');
  } else {
    writeFileSync(OUTPUT_PATH, generated);
    process.stdout.write(`Wrote contracts/openapi.json from the kit document plus the overlay.\n`);
  }
}
