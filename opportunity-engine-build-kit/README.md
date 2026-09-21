# Opportunity Engine · Build kit 2.0

**For Claude Code, Codex and a human product/design team.** Prepared 21 September 2026.

This is an implementation handoff with executable reference logic, machine-readable contracts, a SQL migration candidate, test fixtures, and a standalone design concept. **It is not a running production platform.** Start with `START_HERE.md`.

## Open first

- `START_HERE.md`: what to do, exact first prompt and what runs today.
- `design/preview.html`: offline interactive Evidence Desk concept. Its data and captures are explicitly synthetic local fixtures; it never scans the internet or sends anything.
- `HANDBOOK.html`: browsable, searchable handoff documents in one offline file.
- `VERIFICATION.md`: checks actually performed on this kit and checks still required for the application.

## Run the handoff checks

Requires Node.js 22.16 or newer. No package installation, credentials or internet are required for the dependency-free reference tests.

```bash
npm test
npm run preview
```

The preview server binds only to `127.0.0.1:4178` and serves the handoff preview and handbook, not arbitrary repository files. You can also open the HTML files directly. Stop the server with Ctrl+C.

These commands test **reference behavior and kit integrity**, not a working API, database, cloud deployment or production security boundary. M0 scaffolds the actual application and pins its dependencies.

## Handoff map

| Area | Entry point |
|---|---|
| Agent instructions | `AGENTS.md`, `CLAUDE.md` |
| Full product rationale | `BUILD_SPEC.md` |
| Implementation sequence | `IMPLEMENTATION_PLAN.md`, `tasks/` |
| Visual/UI/UX direction | `design/DESIGN_BRIEF.md`, `design/UI_SPEC.md` |
| Architecture, tenancy, permissions and budgets | `docs/architecture/` |
| API and domain contracts | `contracts/` |
| Database candidate and verification plan | `db/`, `docs/architecture/DATA_MODEL.md` |
| Deterministic reference code | `reference/` |
| Reproducible local fixture pages | `fixtures/` |
| Start/design/build/review/resume prompts | `prompts/` |
| Acceptance and release | `docs/quality/`, `ops/` |
| Original research and references | `source/`, `SOURCES.md` |

Do not upload or commit credentials, real customer data, model-generated evidence masquerading as a capture, or font files. No new cloud subscriptions or production changes are authorized by possessing this kit.
