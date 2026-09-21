# ADR-020 · A request is not permission, and the host decides the workspace

**2026-09-21 · accepted**

## Problem

M3 opens the first unauthenticated surface in this system: "Add separate public intake API
with abuse rate limits, purpose text, target validation, verified request channel and
per-request cost ceiling. Do not accept arbitrary unauthenticated browsing at operator
limits."

Every other endpoint resolves its workspace from a verified identity. This one has no
identity to resolve from, which makes two questions urgent that nowhere else has had to ask:

1. **Whose workspace does a stranger's submission belong to?** BUILD_SPEC.md §14 rules out the
   obvious answer: "Clients never choose a tenant by sending an arbitrary trusted body field."
2. **What does a verified request entitle anybody to?** The temptation is to say "we verified
   them, so we can scan the site they named." That is wrong, and it is wrong in the direction
   that gets a site scanned on the say-so of somebody who does not own it.

## Decision

**The host decides the workspace.** An owner registers a public hostname as an intake channel;
a submission arriving on that host belongs to that channel's workspace and venture. There is
no tenant, venture or account field in any public request body, and the contract has no place
to add one. Resolution runs on the identity connection with no tenant context, under one
narrow policy — the same shape as membership resolution (ADR-013), because it is the same
problem: the tenant is the answer to the lookup, so it cannot also be its precondition.

The hostname index is **global, not per tenant**. Two workspaces claiming one public hostname
would make the tenant of an incoming request ambiguous, which is the single thing this table
exists to decide. A hostname is a public fact, so the cross-tenant visibility that implies
costs nothing.

**A request is not permission.** Verifying a contact address proves control of an inbox. It
proves nothing about the website the requester named. So a verified request is a row in a
queue, and nothing more: no account appears, no authorization appears, no scan is admitted and
no budget moves. An owner still establishes site control separately and records the account
and the authorization by hand, exactly as in M1. The requester's assertion about their own
authority is stored as `authority_claim` and rendered in the operator UI as a quotation, in
their words, under the line "Recorded as a claim, not established as a fact."

**The same address rules as an operator-started scan.** `preflightTarget` was split into
`preflightAddress` (scheme, credentials, port, IP literals, hostname shape, sensitive query,
state-change path) plus the account allowlist. Intake runs the first; the operator path runs
both. A split rather than a copy, for the reason ADR-015 gives: a second, looser copy of a
safety rule eventually becomes the only one anybody reads. A public form that accepted what
the internal path refuses would be the way around every address rule in the system.

**Four rate-limit windows, counted before the decision.** Per contact address, per source, per
target host, and the owner's own daily ceiling per channel. All four are counted for every
submission, including the ones about to be refused — a limiter that counts only what it
accepts is one an attacker can run flat out for free, and the validation path is exactly what
they would run. All four are judged together and the strictest wins, so a caller who reliably
trips one rule is still counted against the others.

The counters live outside the tenant boundary, in `oe_public.rate_limits`. This is the ADR-014
shape: the thing being counted crosses the boundary, so the counter has to. One attacker
submitting to twenty channels is one attacker, and a per-tenant counter would hand them twenty
budgets. The table holds no tenant data and no personal data — every key is an HMAC the
application produces from a secret the database never sees, and a `CHECK` constraint refuses a
key that is not one. The runtime role counts through a `SECURITY DEFINER` function and holds
nothing on the table itself, so it can neither read another key's total nor clear its own.

**A one-time code, hashed, short-lived, attempt-limited, single use.** Six digits, ten minutes,
five attempts, consumed on first success. The digits are the weak part and the ceiling is the
strong part: five guesses at a million values is one in two hundred thousand, and a successful
guess buys one queue entry rather than a standing capability. Stored as an HMAC keyed by a
secret outside the database and mixed with its audience, so reading the database recovers
nothing and a code minted for one purpose cannot satisfy a check for another.

**No adapter that sends mail.** M3 says the delivery adapter comes "only with owner approval",
and there is none. The port exists with two implementations: one that refuses and says so, and
one that returns the code to the caller and refuses to construct outside `APP_ENV=local`.
Startup rejects `PUBLIC_INTAKE_ENABLED=true` without a configured channel and a 32-character
secret, and rejects the code-returning channel in any deployed environment.

**Asking for a check is not agreeing to be marketed to.** `marketing_consent` defaults to
false, is absent from the insert statement the submission path uses, and carries a constraint
requiring a timestamp alongside it — consent is an act with a moment, not a flag. Turning it
on has to be its own recorded act.

## What the public may learn

Three states, not five: `pending`, `received`, `closed`. A decline and an expiry are both
`closed`, because a decline is an internal judgement that may be about the requester. An
unregistered host, a closed form and a disabled feature all answer 404, so probing cannot map
which workspaces have intake turned on. Every verification refusal — expired, wrong, already
used — returns one message, because the differences are all things an attacker would like to
tell apart.

## Two things this got wrong first

**The attempt ceiling did not work.** Read, count and judge all ran in one transaction, and a
wrong code threw — which rolled the counter back with everything else. Five wrong guesses cost
nothing and the sixth still worked. It now runs in three transactions: the count is committed
before the comparison, so a guess is paid for before it is answered. The integration test for
the ceiling is what found it; the comment claiming the behaviour was already there.

**`verified_at` was constrained as an equality.** `(state IN ('verified','converted')) =
(verified_at IS NOT NULL)` forbade declining a request that had been verified first, because
declining moved the state while the timestamp stayed. Verification is a thing that happened and
stays having happened; the constraint is now an implication.

## Alternatives rejected

- **A tenant or venture field in the submission body.** The thing BUILD_SPEC.md §14 names
  outright. Any client could then pick a workspace, and the only defence would be a check
  somebody remembers to write on every new endpoint.
- **Treating a verified email as authority over the named site.** This is how a scanning
  service ends up pointed at a competitor by somebody who typed their address correctly.
- **Auto-creating an account from a verified request.** Same failure, one step later: the
  account row is the allowlist every scan is checked against, and minting one from a stranger's
  claim would make that check meaningless.
- **A relaxed address policy for public targets.** ADR-015 rejected the same idea for
  fixtures. The split keeps one copy of the rules.
- **Per-tenant rate limits.** An attacker hitting twenty channels would get twenty budgets.
- **Requiring a CSRF token on the public surface.** There is no session to ride on, so it
  would be a ritual rather than a control. The contract states what protects these operations
  instead, in `x-protected-by`, and a test requires every added operation to declare either a
  minimum role or that.
- **Storing the contact address only as a hash.** Answering the request needs the address.
  It is stored, kept out of the public projection entirely, and gated to reviewer and above in
  the operator projection: a viewer can read the queue without holding a stranger's email.

## Affected contracts

Ten schemas and nine operations through `contracts/overlay.json` (ADR-018). Four public:
`GET /public/intake/form`, `POST /public/intake`, `POST /public/intake/{id}/verify`,
`GET /public/intake/{id}`. Five operator: the request queue, one request, decline, the channel
list and opening or closing a channel.

The public four carry `x-public-surface: true` and `x-protected-by` in place of
`x-minimum-role`. `tests/contract/generated-contract.test.ts` makes that exclusive — an
operation declares a role or declares itself public, never neither and never both — and pins
public operations to paths under `/public`, so an operator endpoint that sets the flag by
accident fails rather than quietly becoming unauthenticated.

## Security and cost

No new egress: intake contacts nothing. No provider spend: a request admits no scan and
reserves nothing, which `tests/integration/intake.test.ts` asserts by comparing the whole
budget projection across a submission.

New surfaces to watch, stated plainly:

- The submission endpoint accepts a body from anybody who can reach a registered host. It is
  bounded by the four windows and by a schema with no field that widens anything.
- The `oe_public` schema sits outside the tenant boundary. It holds counters keyed by HMAC and
  nothing else, and the runtime role cannot read it.
- The contact address is personal data. It is in one tenant-scoped column, out of the public
  projection, out of the audit detail, and gated by role in the operator projection.

## Migration and rollback

`packages/db/migrations/0010_public_intake.sql` is additive: three tables in `oe`, one schema
and one table in `oe_public`, two functions, no change to any existing table. Rolling back
means dropping them and setting `PUBLIC_INTAKE_ENABLED=false`, which makes every public route
answer 404 without any database change at all.

## Verification

- `tests/unit/intake.test.ts` — 22 cases: every address the operator path refuses, refused
  here; the attempt ceiling at its exact boundary; expiry to the second; a spent code; the
  rate-limit judgement over all four rules at once; audience separation in the code hash; and
  the local channel refusing to construct outside `APP_ENV=local`.
- `tests/db/intake.test.ts` — host resolution with no tenant context; two hosts to two
  workspaces; the runtime role unable to register a hostname at all; the global unique index
  refusing a second claim even from the migration role; consent refused without a timestamp;
  one live challenge per request; the counter key constraint; and the runtime role unable to
  read or clear the counters.
- `tests/integration/intake.test.ts` — 27 cases through the real API: replay, cross-channel
  code use, five wrong guesses then a correct one refused, refused submissions still counted,
  a body carrying `tenant_id` rejected, budgets unmoved, consent false after verification, a
  viewer seeing the queue without the address, decline telling the requester only "closed",
  and a closed form answering 404.
- `tests/e2e/operator.spec.ts` — a submission from a venture site through to the operator
  screen, asserting that the screen says "no authority yet" and labels the claim as a claim.

## Status

**Accepted.** `PUBLIC_INTAKE_ENABLED` is on locally and off everywhere else, because there is
nowhere else to run it: no deployment exists, and no adapter can reach a member of the public.
The form itself — the embed for the Astro and Next sites that M3 also asks for — is not built;
the contract and the API it would call are.
