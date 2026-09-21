# ADR-022 · A protected link is not a seat

**2026-09-21 · accepted**

## Problem

A customer who asked for a check has to be able to read the result. ACCESS_MODEL.md already
identified this as the one genuinely hard case in the access model, and gave the wrong answer
to avoid:

> A client who wants to see their own case... is not a `viewer` in your workspace — giving them
> a membership would let them see every other account in it... Do not solve this by creating
> viewer memberships for clients. It is the single most likely way this system leaks one
> customer's data to another.

M3 sets the bar: "tokens are random, short-lived, stored hashed and audience-bound, no PII in
URL. GET tokens never mutate data; prevent replay and cross-report use," with "expiry/
revocation, protected evidence and a non-leaking invalid-link page."

## Decision

**A grant opens one report version and nothing else.** Not the scan, not the evidence
artifacts, not the account, not another report, not a newer version of the same report. There
is no session, no membership and no role attached to it.

**Bound to the version, not the report.** A report that is revoked or superseded stops serving
through a link somebody already holds. Serving the newer document would be a silent
substitution of something a person was given; serving nothing is the honest answer, and
issuing a fresh link is a deliberate act.

**Expiry and revocation live in the database, not the application.** The identity role's policy
is narrower than the query that uses it:

```sql
USING (oe.tenant_context() IS NULL AND revoked_at IS NULL AND expires_at > now())
```

So an expired or revoked grant is invisible to the lookup before any application code could
tell it apart from one that never existed. An application bug can fail to refuse; it cannot
accidentally permit.

**The runtime role cannot change what matters.** It holds `INSERT`, `SELECT`, and `UPDATE` on
exactly three columns — `revoked_at`, `revoke_reason`, `revoked_by`. It cannot extend or
shorten a lifetime, repoint a token at another report or version, or delete a grant. "Expires
in fourteen days" is therefore a fact rather than an intention.

**The token is returned once.** 256 bits of randomness, base64url, stored as an HMAC keyed by a
secret outside the database and mixed with its audience. No operation returns it again: not the
list, not a read, not a re-issue. A retried issue request replays through the idempotency key
and returns the same link, because two live links where the operator meant one is its own
failure.

**`GET` performs no business write.** No counter on the grant, no last-accessed column, no
state change on the report. That a link was used is recorded as an append-only audit event —
history, not state — so a reader cannot change what the next reader sees. An integration test
reads the link ten times and asserts the grant list is byte-identical afterwards.

**Every failure is the same failure.** Expired, revoked, mistyped, belonging to another
workspace, never issued: one 404, one sentence, no hint about which. The token is shape-checked
before it becomes a database lookup at all.

**The delivered shape is an allowlist.** `toDeliveredReport` names the fields that may leave
rather than removing the ones that may not — an allowlist cannot be defeated by a column added
to `oe.reports` later, and a denylist can. Absent on purpose: account id, scan id, report id,
internal state, evidence ids, artifact URLs, reviewer identity.

**Only a published report may be delivered**, and the response carries `x-robots-tag: noindex`.
A shared document is not a page to be indexed.

## Alternatives rejected

- **A viewer membership for the customer.** The thing ACCESS_MODEL.md warns about by name.
- **Checking expiry in application code.** It would work until the one path that forgot. The
  policy makes forgetting impossible.
- **A `last_accessed_at` column.** Useful, and a business write on a `GET` — exactly what M3
  rules out. The audit event carries the same information without letting a reader mutate
  anything.
- **Serving the newest version through an old link.** Convenient and dishonest: the recipient
  would be reading a different document from the one they were sent, with no way to tell.
- **Letting the caller choose the expiry.** A link that outlives what anybody decided is how a
  short-lived credential becomes a permanent one. The lifetime is the server's.
- **Distinguishing "expired" from "revoked" to the reader.** Kinder, and it tells a prober
  which guessed tokens once existed. The operator's list says which, because the operator is
  entitled to know.
- **Serving evidence artifacts through the grant.** Deferred rather than refused: a customer
  may reasonably want the screenshot behind a claim. It needs its own scoping decision, and
  bolting it onto this one would quietly widen what a leaked link is worth.

## Affected contracts

Six schemas and four operations via `contracts/overlay.json` (2.5.0): `ReportGrant`,
`IssuedReportGrant`, `ReportGrants`, `IssueReportGrant`, `RevokeReportGrant`,
`DeliveredReport`; `GET`/`POST /v1/reports/{id}/grants`, `POST /v1/report-grants/{id}/revoke`,
and the public `GET /public/reports/{token}`.

`IssueReportGrant` has no expiry field and no address field. The public operation carries
`x-protected-by` naming all seven things that bound it, which the contract test requires of
any operation declaring itself public.

## Security and cost

No egress, no provider spend. The new surface is one unauthenticated read whose whole
authorization is a 256-bit bearer token; the counters, hashing and secret handling are the
same as M3 slice 1's. The recipient's address is opaque-keyed before storage and never
returned — the operator sees the note they wrote, not the address.

**Not yet done:** rate limiting the public read. Guessing a 256-bit token is infeasible, so the
limiter would be protecting against load rather than against discovery. It belongs with the
other operational work in M5 and is recorded here rather than assumed.

## Migration and rollback

`packages/db/migrations/0012_report_grants.sql` adds one table, one global unique index and one
identity policy. Nothing existing changes. Rolling back means dropping the table; every link
then stops working, which is the correct failure.

## Verification

- `tests/db/report-grants.test.ts` — the identity role seeing neither revoked nor expired
  grants; the global token uniqueness; the runtime role unable to extend a lifetime, repoint a
  token or delete a grant; audience separation; and the revocation constraints.
- `tests/integration/report-delivery.test.ts` — a draft refused, an operator refused, the token
  returned once and absent from the list, a retried issue returning the same link, ten reads
  leaving the grant untouched, one answer for four kinds of bad token, expiry enforced by
  moving the row rather than the clock, reissue after expiry not reviving the old link,
  revocation taking effect on the next read, and a report revocation stopping a live link.
- `tests/e2e/operator.spec.ts` — the whole seam in the browser, including the screen refusing
  to offer delivery for a draft and the withdrawn link refusing on the very next read.

## Status

**Accepted.** The link points at the JSON the API serves, which works; a branded HTML reader,
including the invalid-link page as a _page_, is M3 slice 3.
