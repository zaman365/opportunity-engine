# ADR-018 · extend the handoff contract by overlay, never in place

**2026-09-21 · accepted**

## Problem

M2 implements a detector the M1 contract cannot express: `CreateScan.detectors` is pinned to
`const: "MF-LINK-01"` with `maxItems: 1`. AGENTS.md requires machine contracts to change in the
same commit as the code. But the kit's `contracts/openapi.json` is a handoff artifact whose
hash is recorded in its `SHA256SUMS`, and editing it in place would break that record silently.

## Decision

The kit's document stays byte-identical and becomes the **base**. `contracts/overlay.json`
states each change as one RFC 6901 pointer assignment with a written reason.
`scripts/build-contract.mjs` applies them and writes `contracts/openapi.json`, which is what
the API serves and what the Zod mirrors are checked against.

Two operations, deliberately distinct:

- `set` requires the target to already exist, so a typo in a pointer fails loudly instead of
  inventing a property the base never had.
- `add` requires the parent to exist and the leaf to be absent.

`npm run contract:check` fails when the committed file is stale.

## What the tests enforce

`tests/contract/generated-contract.test.ts`:

1. Regeneration is deterministic and matches the committed file.
2. Every M1 path, `operationId` and component schema survives; no operation's minimum role is
   lowered; every unsafe operation still requires an Idempotency-Key and a CSRF token.
3. Every example the kit ships still validates.
4. **Request** schemas only widen — a new required property on one fails the suite, because it
   would reject a call that used to work.
5. **Response** schemas may gain required properties, because that only obliges the server to
   send more and the integration tests prove it does. The two directions are separated
   explicitly rather than lumped under one "compatibility" claim.
6. Every overlay entry carries a `why` of real length. An unexplained contract change is a
   review gap.

## Current overlay

| Change                                                           | Direction           |
| ---------------------------------------------------------------- | ------------------- |
| `CreateScan.detectors` accepts `MF-ASSET-01`, up to two, unique  | Request, widening   |
| `Evidence.observation` added and required                        | Response, narrowing |
| `Session.implemented_detectors` added and required               | Response, narrowing |
| `info.version`, `info.description`, `POST /v1/scans` description | Documentation       |

The detector enum stays an allowlist: MF-DATA-01, PDP-CONTENT-01, PDP-VISUAL-01 and
PDP-MOBILE-01 are specified in `contracts/detectors.json` and remain unrequestable until they
exist. The same list drives admission (`IMPLEMENTED_DETECTORS`) and the database constraint, so
a detector cannot become requestable in one layer and not another.

## Alternatives rejected

- **Editing the kit's document.** Breaks its integrity record and destroys the ability to tell
  later what the handoff actually said.
- **A hand-written second contract.** Nothing would prove it still satisfies M1, and the two
  would drift on the first change nobody re-read.
- **Skipping the contract change and validating only in code.** The contract would then
  describe an API that does not exist, which is the failure mode AGENTS.md's "update contracts,
  migrations, tests and docs together" exists to prevent.
