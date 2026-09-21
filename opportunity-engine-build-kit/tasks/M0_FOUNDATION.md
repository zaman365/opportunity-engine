# M0 · foundation and authored design

## Outcome

A real application scaffold and reproducible local toolchain, with the starting contracts, security boundary and visual direction understood. This is not “all platform screens generated.”

## Tasks

Audit existing repo/branch/user changes; record actual files and dependencies. Preserve kit source/reference artifacts. Establish apps/operator, apps/api, workers/scan-runner and shared contracts/db/domain packages as a modular monorepo. Use a real supported stable package set with lockfile and environment record; no guessed versions. Add actual dev/build/type/lint/test scripts.

Implement config validation that fails closed for absent provider/auth and rejects fixture mode in deployed environments. Add isolated fixture transport and initial API health/readiness separation. Health proves process live; readiness checks required bindings without spending money.

Review the provided schemas/SQL. Add Drizzle types or reviewed SQL migration mapping without a second divergent schema. Create local disposable PostgreSQL test commands and separate runtime/migration roles. No cloud provisioning required for this local step.

Design D0: read brief, render at least two compositions on the same case using fixture content; critique task clarity and uncertainty. Record a provisional choice and extract initial tokens. Keep the concept app clearly synthetic until actual API wiring exists.

## Acceptance

Kit baseline tests retained. Scaffold actually builds/typechecks. Invalid config fails with specific reason. No real secrets/default production admin. Local auth cannot be enabled on a deployed origin. Designer has actual rendered alternatives and a rationale, not only prose. PROGRESS identifies what was verified and what requires paid/external resources.

## Done artifact

Repo inspection note; locked dependency/environment manifest; build logs; architecture deviations if any; actual route shell and empty states; design study screenshots; test commands.
