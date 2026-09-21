# Start here

## The decision

Use this kit to build one complete, tested evidence-to-report workflow, then expand. Do not ask an agent to generate every platform screen at once.

## What you have

A complete handoff for the staged platform: product rationale, resolved starting architecture, detailed milestone tasks, visual/UI/UX direction, OpenAPI and domain schemas, database migration candidate, deterministic reference functions, tests, fixture site, and an interactive design concept. M1 is intentionally more prescriptive than later integration phases.

What you do **not** have yet: deployed application code, a configured identity provider, production database/resources, live scan adapters, a billing integration, or proven commercial demand. Their implementation and release gates are included, not claimed complete.

## Get started in either coding tool

1. Extract the whole archive into a dedicated local repository directory. Keep the folder structure. Do not copy only BUILD_SPEC.md.
2. Open that directory in Claude Code or Codex. In an existing repo, first commit/checkpoint current work; merge instruction files rather than overwriting existing guidance. Never overwrite someone else's uncommitted changes.
3. Paste `prompts/00_START.md`. The agent begins with the repository audit, reference tests, design concepts and M0/M1 implementation. It records assumptions and blockers without inventing integrations.

The shared rules live in AGENTS.md. CLAUDE.md imports that file; it is deliberately small. No tool-specific permissive settings or automatic spending permissions are included. See SOURCES.md for the official instruction-file documentation.

## First prompt

```text
Read START_HERE.md and AGENTS.md. Inspect the repository and run npm test.
Use BUILD_SPEC.md as the product brief and IMPLEMENTATION_PLAN.md as the sequence.
Read design/DESIGN_BRIEF.md before building UI. Develop distinct composition
studies for the same evidence-review task; provisionally use Evidence Desk
unless the critique supports another direction. Do not clone the preview.
Complete M0 and then implement the first feasible M1 work, including its
contracts, data isolation, real state transitions and acceptance tests.
Use the supplied fixtures locally; never represent fixtures as live integrations.
Do not deploy, purchase services, contact prospects or modify customer systems.
Record tested results, missing credentials and the next task in PROGRESS.md.
```

## Decide only what needs your authority

The kit resolves routine technical choices. The owner still controls cloud account/resource creation, paid usage ceilings, legal/data-processing approval, identity membership, approved scan targets and production release. Missing authority blocks that external action—not all local development. Build tests and a truthful unconfigured state in the meantime.

## Review the visual direction

Open `design/preview.html` directly in a browser. Search and filter the fictional review queue, open a case, inspect fixture evidence, switch inspection modes, record a local review decision, and inspect blocked states. No network services are called. This reference demonstrates hierarchy and interaction; the designer must still explore alternatives, specify the real system and validate accessibility.

## Commands that work in this kit

```bash
npm test                     # reference tests plus kit integrity
npm run test:reference       # reference tests only
npm run check:kit            # file/contract/reference consistency checks
npm run preview              # local handoff viewer on 127.0.0.1:4178
npm run fixtures             # local fixture website on 127.0.0.1:4179
```

`npm run build`, `npm run dev:app` and deployment commands are not supplied as pretend successes. M0 adds the real app commands and their verification. Read VERIFICATION.md before interpreting any green test output.
