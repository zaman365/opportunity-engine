# Environment inventory

The repository has two modes: **handoff/reference** (works now without installation) and **application** (created in M0). Never conflate them.

## Handoff mode

Node ≥22.16; `npm test`; `npm run preview`; `npm run fixtures`. No external accounts, credentials, network scanning or payment usage. HTML files are self-contained and work when opened directly.

## Application mode to establish in M0

Resolve and pin supported development runtime and compatible stable packages: React, TypeScript, Vite, Hono, Zod, Drizzle, pg, jose, Worker tooling, Playwright and test/contract validators. Write exact versions and actual test commands into an environment manifest. Preserve the kit scripts under explicit names if root scripts change. No `latest` manifests or fake build commands.

Bindings: Access application issuer/audience; Hyperdrive runtime DB; separate migration URL; R2 private EU jurisdiction bucket; Workflows binding; Browser Run binding only after approval; optional model provider in M2. Use current official binding syntax from SOURCES.md. Real resource IDs are not supplied or invented.

Data: seed only local fixtures. Production has no default admin email, no default tenant membership and no pre-populated findings. Bootstrap initial membership through an audited owner procedure after identity verification.

M1 has no customer payment provider and no email provider dependency. M3 introduces requested-report delivery and explicit accepted-scope accounting; paid service integration is a separate approval.


## Optional authoring checks

`python scripts/validate-contracts.py` requires the optional `jsonschema` package. `python scripts/test-preview.py` requires Playwright and an approved Chromium executable; set `CHROMIUM_PATH` when necessary. `verification/requirements.txt` records the versions used for those two checks. These are not application runtime dependencies or part of the dependency-free Node reference tests. See VERIFICATION.md for browser-environment limitations.
