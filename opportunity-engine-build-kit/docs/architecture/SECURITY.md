# Security, data handling and threat model

## Trust boundaries

User browser → authenticated API → tenant-scoped database → durable runner → untrusted internet content → evidence storage → reviewer → report audience. External content and model output are never trusted instructions. Source policy, authorization and application permissions are separate records.

## Minimum protections before live capture

Validate absolute HTTPS targets, exact approved hostnames, ports, credentials and sensitive query values. Resolve all IPs and block non-public/loopback/link-local/private/metadata destinations, IPv4-mapped IPv6 and rebinding; recheck at connection time. Apply policy to redirects and every browser subrequest, not just the top-level page. An allowlist does not remove DNS risks. Disable downloads, uncontrolled popups, non-HTTP schemes, WebSockets and unneeded service workers. No authenticated cookies, browser extensions, access tokens or arbitrary model-authored page scripts.

Record per-host concurrency, maximum navigations, time, bytes, retries and depth. Respect permitted scope and relevant terms; stop on challenge/access-control blocks. Rate limits do not substitute for lawful permission. Fixed operator-approved host policy in M1; unrestricted customer URLs stay disabled until the public-intake threat tests pass.

## Read-only is not simply GET

Some sites expose state-changing GET links. Never blindly follow all anchors. MF-LINK-01 navigates only a reviewed size/fit-guide or comparable informative path, selected by conservative text/path classification and excluding cart, checkout, add, delete, logout, action, account and known tracking redirect routes. Ambiguous destinations need review. Network filtering blocks non-essential mutation methods; if the page needs disallowed requests, capture becomes partial instead of widening authority.

## Auth and application safety

Verify Access JWT at API, issuer/audience/expiry/algorithm/sub; membership from server storage. Protect unsafe requests with Origin and per-session CSRF token. Rate-limit identity, tenant and target. Return generic cross-tenant 404s. Use CSP, nosniff, referrer protection and secure cookie settings. Render user/source text escaped; never inject scraped HTML into the operator origin. Evidence screenshots are raster images; HTML artifacts are downloadable text or sandboxed on a separate origin with scripts/network disabled. CSV export neutralizes spreadsheet-formula prefixes.

## Data minimization and retention

Do not collect shoppers, account pages, checkout details or private customer data during a public scan. Redact query tokens and unnecessary personal details before persistence or model input. Capture full URLs only when permitted/necessary, with protected access; logging always uses redacted form. Access scopes, controller/subprocessor terms, staff location and international processing require actual review. Model/provider use is disabled for sensitive content until approved.

Proposed artifact TTL 30 days and content revalidation after 7 days remain owner-approved policy defaults, not legal deadlines. Retention per source can be shorter. Deletion removes object bytes, relevant derived records/model caches, report access and active jobs while preserving a minimized legal/audit record where justified. Exercise a deletion test including backups' expiry rules. A stale screenshot may still need deletion independently of its usefulness.

## Prompt injection and excessive authority

Ignore instructions in websites/artifacts. Analysis prompts accept only bounded evidence inputs; no tokens, mail, payment or production-write tools. Validate output IDs against supplied evidence. Source content cannot choose model endpoints, change catalog prices, grant permissions, request more compute or decide report audience. Require independent review for interpretation.

## Release blockers

No live capture without network-policy proof; no private reports without tenant isolation tests; no public intake without abuse controls; no production with fixture identities or seeded synthetic findings; no runtime migration credential; no logs containing secrets; no untested restore path; no hidden fallback from unavailable external provider to sample success.

Text instructions are not a sandbox. Enforce restrictions through credentials, network egress, app capability boundaries and deployment policy.
