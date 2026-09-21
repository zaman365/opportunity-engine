# ADR-011 · port the reference logic, prove parity

**2026-09-21 · accepted**

## Problem

The kit ships `reference/*.mjs` — scoring, money, state transitions, the URL preflight and the
MF-LINK-01 rule — as dependency-free JavaScript that must stay byte-identical. The application
needs the same logic in typed TypeScript. AGENTS.md allows reuse "only after inspection" and
forbids a silently divergent second copy.

## Decision

Reimplement each module in `packages/domain/src` as TypeScript, and assert behavioural parity
against the originals in `tests/unit/reference-parity.test.ts`. The test imports both the kit's
`.mjs` and the port, and runs a shared table of inputs — including every abstention case of the
detector and every denial reason of the URL policy — asserting deep equality of the results.
The state-machine table is additionally compared edge-for-edge against
`contracts/state-machines.json`.

## Alternatives rejected

- **Import the `.mjs` directly.** Reaching outside the workspace root breaks bundling for the
  operator and leaves the logic untyped at every call site.
- **Copy without a parity test.** The two copies would drift the first time one is edited, and
  nothing would notice.

## Contracts

`packages/domain` re-exports the same function names and result shapes. `PriorityScore` in
`@oe/contracts` is the return type of `scoreOpportunity`, so a change to either fails
typecheck.

## Rollback

Delete the port and import the `.mjs` behind a shim. The parity test becomes redundant.

## Verification

38 parity assertions pass, plus the state-machine comparison. The kit's own suite
(`npm run kit:test`, 114 tests) is unchanged and still passes.
