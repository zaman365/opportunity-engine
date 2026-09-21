# ADR-015 · a separate fixture target policy

**2026-09-21 · accepted**

## Problem

M1 runs against the kit's loopback fixture site at `http://127.0.0.1:4179`. The production URL
policy rejects that on three counts — http, an IP literal, and a non-public host — and
TEST_PLAN.md is explicit: "never weaken production URL policy to make a fixture work."

## Decision

Two policies, selected by configuration, never one relaxed policy.

- `productionTargetPolicy` wraps `preflightTarget` unchanged: https only, public hostnames
  only, no IP literals, no embedded credentials, no non-default ports.
- `createFixtureTargetPolicy(origin)` admits exactly one loopback origin. Everything else is
  identical: the account's approved-host list still gates the target, state-changing paths are
  still refused, token-like query parameters are still rejected. Its constructor throws for a
  non-loopback origin.

`loadConfig` refuses `CAPTURE_ADAPTER=local_fixture` outside `APP_ENV=local`, so a deployed
build cannot construct the fixture policy at all. The API and the scan runner are handed the
same policy object, so a scan is executed under the policy it was admitted under.

## Alternatives rejected

- **Adding loopback to the production allowlist behind a flag.** One misconfiguration away
  from an SSRF primitive in production, and it makes the production tests weaker.
- **Hosting the fixture on a public https domain.** Needs a domain and a deployment, neither of
  which this kit authorises.

## Verification

`tests/unit/config.test.ts` asserts the deployed-environment refusals.
`tests/integration/journey.test.ts` asserts that an unapproved host, a cart path and a
token-bearing URL are all refused through the real API even in local mode.
