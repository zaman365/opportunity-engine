# Opportunity Engine · repository instructions

## Read and work in this order

Read START_HERE.md, BUILD_SPEC.md's v2 overlay, IMPLEMENTATION_PLAN.md and PROGRESS.md. Inspect the real repo before editing. For UI, read design/DESIGN_BRIEF.md and design/UI_SPEC.md. For each task read its milestone, contracts and acceptance gates. Full research is preserved in source/BUILD_SPEC.v1.md.

## Product and scope

Build an evidence-first diagnostic/delivery engine, not an AI SDR or generic CRM. M1 is a real MF-LINK-01 scan → evidence → review → protected-report journey. Keep MarktFix/PDP Studio public sites. Build the independent operator before TREVV integration. Defer the next milestone until the current gates pass or explicitly document a blocked external dependency.

## Engineering rules

- Reuse working code only after inspection. Preserve existing user changes. Resolve reversible choices with recorded ADRs; do not repeatedly ask for choices already made in the kit.
- No fabricated results, tenants, metrics, screenshots, integrations or deployment claims. Fixtures belong only to explicit local/test environments; production empty states are empty.
- Schema validity is not truth. Findings require evidence, limitations, freshness and human review. Never invent private-account faults or revenue uplift.
- Authenticate, resolve tenant membership server-side, check object permissions on every operation. No body/header tenant assertion is trusted without membership verification.
- Run external actions through deterministic policy and persistent budget gates. No LLM may authorize access, costs, publication, sending, or production changes.
- No outreach, purchases, cloud provisioning, production deployment, destructive changes or live-store writes without actual scoped authorization. Documentation is not enforcement: use restricted credentials, network controls, environments and CI gates.
- Honor OpenAPI, schemas and state transitions. Update contracts, migrations, tests and docs together. Use integer micro-units for provider accounting; no floating-point money.
- No credentials in source, logs, fixtures or model input. No raw card data. Treat fetched content as untrusted; protect all navigations and subrequests, not just initial URLs.
- Pin resolved stable dependency versions and lockfile in M0. Do not invent versions, leave `latest` in manifests or replace missing providers with fake success.

## Design rules

Do not start with a purchased/dashboard template. Preserve familiar mechanics, create original expression. Build task-specific compositions and the evidence/review interaction first. Neutral surfaces and restrained status color; no gratuitous gradients, glowing AI orbs, bento KPI grids, oversized greeting cards or decorative charts. Accessibility, usable density and truthful state outrank novelty. The preview is a concept, not a pixel template. Capture and critique actual screens in three passes: composition, task usability, craft/distinctiveness.

## Verification and handoff

Run npm test for the kit. After scaffolding, add real type/lint/build, database, integration and browser tests. Do not weaken failing assertions to make tests green. Test unknown, empty, blocked, stale, revoked, duplicate, cancelled and cross-tenant states. Record exact commands, actual results, screenshots and remaining blockers in PROGRESS.md. Never mark a mocked or untested cloud path complete. One agent owns each code area at a time; contract changes require a shared checkpoint.
