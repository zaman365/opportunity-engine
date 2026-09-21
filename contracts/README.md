# Served API contract

`openapi.json` here is **generated**. Do not edit it by hand.

```
opportunity-engine-build-kit/contracts/openapi.json   the M1 handoff contract, byte-identical
                    +  overlay.json                    this milestone's changes, each with a reason
                    =  contracts/openapi.json          what the API serves
```

Regenerate with `npm run contract:build`; `npm run contract:check` fails when the committed
file is stale.

## Why a generated file instead of editing the kit's

The kit's contract is a handoff artifact whose integrity is recorded in its `SHA256SUMS`.
Editing it in place would break that record silently and make it impossible to tell later what
the handoff actually said. Keeping it as an immutable base means every difference between the
handoff and what we serve is one line in `overlay.json` with a written justification.

## What the tests enforce

`tests/contract/generated-contract.test.ts`:

1. Regeneration is deterministic and matches the committed file.
2. Every M1 path, `operationId` and `x-minimum-role` in the kit's document survives unchanged.
3. Every example the kit ships still validates against the generated document.
4. The overlay only **widens**: anything the M1 schema accepted, the generated schema accepts.
   A change that would reject a previously valid payload fails the suite.

`tests/contract/openapi-conformance.test.ts` then checks the Zod mirrors in `@oe/contracts`
against the generated document, in both directions, on positive and negative payloads.

## Current overlay

| Change                                                             | Why                                                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `CreateScan.detectors` accepts `MF-ASSET-01` and up to two entries | Implemented in M2. Still an allowlist: the four specified-but-unimplemented detectors stay unrequestable. |
| `info.version`, `info.description`                                 | The served document is not the handoff document and says so.                                              |
| `POST /v1/scans` description                                       | The operation admits two detectors now.                                                                   |
