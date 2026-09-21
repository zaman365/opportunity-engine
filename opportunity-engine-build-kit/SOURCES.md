# Sources and provenance

Official public documentation checked on **21 September 2026** for this execution kit. Design choices, thresholds and milestone decisions are project proposals, not claims these sources prescribe a visual style. No official source guarantees application correctness.

## S1 · Codex project instructions

https://developers.openai.com/codex/guides/agents-md/

Root/project instructions; latest page redirects to official ChatGPT Learn agent configuration documentation.

## S2 · Claude Code project memory and imports

https://code.claude.com/docs/en/memory

CLAUDE.md imports and scoped project instructions.

## S3 · W3C target size minimum

https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html

WCAG 2.2 AA target-size criterion including exceptions; product target is separately labelled.

## S4 · W3C focus not obscured

https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html

Focused controls must not be entirely hidden by authored content.

## S5 · Cloudflare Workflows

https://developers.cloudflare.com/workflows/

Durable workflow steps, retries and orchestration.

## S6 · Cloudflare Browser Run

https://developers.cloudflare.com/browser-run/

Managed browser capability and global execution context; not proof of app-specific egress safety.

## S7 · Drizzle with Hyperdrive

https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/

Documented Worker/PostgreSQL integration; actual chosen versions need app testing.

## S8 · R2 data location

https://developers.cloudflare.com/r2/reference/data-location/

Jurisdiction controls versus location hints; does not imply EU-only processing of the whole app.

## S9 · Hono on Cloudflare Workers

https://hono.dev/docs/getting-started/cloudflare-workers

Worker deployment pattern.

## S10 · Validate Cloudflare Access JWTs

https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

Cryptographic validation before trusting identity.

## S11 · W3C contrast minimum

https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html

Text contrast criteria; actual screens still require testing.

## S12 · PostgreSQL row security

https://www.postgresql.org/docs/current/ddl-rowsecurity.html

RLS, owner/BYPASSRLS behavior and default-deny semantics.

## S13 · PostgreSQL explicit locking

https://www.postgresql.org/docs/current/explicit-locking.html

Transactional locking and concurrent access design.

## S14 · OpenAPI 3.1.1 specification

https://spec.openapis.org/oas/v3.1.1.html

Contract format, schemas and operations.

## S15 · Claude Code verification practices

https://code.claude.com/docs/en/best-practices

Verification-driven coding workflow.

## Original research

The full Explee/market/legal analysis and its prior source list are preserved in source/BUILD_SPEC.v1.md. Historical repository statements are inherited observations, not a fresh audit in this kit. The coding agent must inspect the actual working repository at M0 before reusing its code or claiming deployment health. No customer databases or production repositories were changed to prepare this kit.

## Assets

No font binaries, third-party UI screenshots, real customer data, licensed product photography or generated merchant proof are included. The design concept embeds browser screenshots of the included synthetic local fixtures. Its UI/text/CSS and handoff documents are authored for this project.
