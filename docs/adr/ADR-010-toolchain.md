# ADR-010 · pinned toolchain

**2026-09-21 · accepted**

## Problem

ADR-008 requires a "currently supported Node LTS development toolchain and stable compatible
package versions … resolved at M0 using official docs/registry", with exact versions and a
lockfile, and forbids inventing versions.

## Decision

Every version below was read from the npm registry on 2026-09-21 and committed exactly, with
`package-lock.json`. Node 22.19.0 is the local runtime; `engines` requires ≥22.16.

| Package                    | Version          | Note                                              |
| -------------------------- | ---------------- | ------------------------------------------------- |
| typescript                 | 6.0.3            | Not 7.0.2, see below                              |
| vite                       | 8.3.0            | with `@vitejs/plugin-react` 6.1.1                 |
| react / react-dom          | 19.3.0           |                                                   |
| react-router-dom           | 7.18.4           |                                                   |
| hono                       | 4.13.8           | with `@hono/node-server` 2.1.1                    |
| zod                        | 4.6.5            |                                                   |
| drizzle-orm / drizzle-kit  | 0.45.2 / 0.31.10 | declared; the M1 data access is parameterised SQL |
| pg                         | 8.23.0           |                                                   |
| jose                       | 6.2.12           | Access JWT verification                           |
| vitest                     | 5.0.1            |                                                   |
| @playwright/test           | 1.63.0           |                                                   |
| eslint / typescript-eslint | 10.11.0 / 8.70.0 |                                                   |
| ajv / ajv-formats          | 8.20.0 / 3.0.1   | contract conformance                              |

## Why TypeScript 6.0.3 and not 7.0.2

7.0.2 is the registry's `latest`. `typescript-eslint@8.70.0` declares
`typescript: ">=4.8.4 <6.1.0"`, so type-aware linting does not support 7.x yet. Choosing 7.x
would have meant dropping the lint gate that AGENTS.md's engineering rules depend on. 6.0.3 is
the newest stable release inside the supported range.

Revisit when `typescript-eslint` publishes a release whose peer range includes 7.x. The change
is a version bump plus a `npm run typecheck && npm run lint` run; nothing in the source depends
on 6-versus-7 behaviour.

## Alternatives rejected

- **TypeScript 7.0.2 with lint disabled.** Trades a working quality gate for a version number.
- **TypeScript 7.0.2 with `oxlint`.** A second linter with a different rule set, adopted under
  time pressure rather than after evaluation. Not a decision to make sideways.

## Contracts, security and cost

None affected. No paid service is contacted by any of these packages.

## Rollback

Revert `package.json` and `package-lock.json` together; there are no generated artifacts.

## Verification

`npm run typecheck` (three projects), `npm run lint`, `npm run build`, and the four test
suites all ran on this set. Exact results are in PROGRESS.md.
