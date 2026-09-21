# M3 · Public intake and protected report delivery

Supersedes `opportunity-engine-build-kit/tasks/M3_CUSTOMER_AND_ENGAGEMENTS.md`. The engagement
half of that document moved to [M4](M4_OFFERS_AND_SERVICE_SCOPE.md); what remains here is one
coherent thing: how a request gets in, and how a result gets back out.

## Outcome

```
public request → verification → scan/report creation → protected report delivery
                                                     → optional accepted scope (M4)
```

Somebody outside the workspace asks for a check through a venture's own site, proves control
of their contact address, and — once a person has reviewed the result — receives a protected
report through a link that expires and can be revoked. No unsolicited campaigns, and no
marketing consent inferred from any of it.

## Slice 1 · requested intake — **done**

Public submission, four rate-limit windows, hashed single-use codes, host-bound tenant
resolution, an operator queue and a decline path.
[ADR-020](../adr/ADR-020-requested-intake.md).

Two rules carry it, and both are load-bearing for everything after:

- **The caller does not choose the workspace.** It comes from the host the request arrived on.
- **A request is not permission.** Verifying an address proves control of an inbox, not of a
  website. No account, no authorization, no scan, no budget movement.

## Slice 2 · protected report delivery — **done**

A grant opens one report version, for one recipient, for two weeks, revocably, and nothing
else. [ADR-022](../adr/ADR-022-report-delivery.md).

- 256-bit token, stored only as a keyed hash, audience-bound, returned exactly once.
- Expiry and revocation are enforced by the identity role's row policy, so an expired or
  revoked grant is invisible to the lookup before any application code could decide otherwise.
- `GET` performs no business write. Use is recorded as an append-only audit event, not as
  state a reader could change.
- One answer for every bad link — expired, revoked, mistyped, another workspace's, never
  issued — because the differences are what a prober wants.
- The delivered shape is an allowlist: no account id, no scan id, no evidence ids, no artifact
  URLs, no reviewer identity. A column added to `oe.reports` later cannot ride out through it.
- The runtime role cannot extend a lifetime, repoint a token or delete a grant.

**Still owed here:** a branded HTML reader. The API serves JSON today and the issued link
points at it, so the link works — but the customer-facing page, including the non-leaking
invalid-link page as a _page_ rather than a problem document, is slice 3.

## Slice 3 · embedding the form — **done**

`GET /public/intake/embed.js` is one script tag and one container element. No framework, no
build step, and nothing configurable that matters:

- **It derives its origin from its own URL**, so an embedding page cannot point it at another
  workspace by editing an attribute.
- **It renders the channel's purpose text as text**, fetched from the API. A page that could
  supply its own wording could promise anything in this system's name; one that could style it
  could hide it. A form that cannot fetch its disclosure does not render at all.
- **Shadow DOM both ways**, so the host site cannot restyle a disclosure it did not write.
- **No marketing checkbox** — not an unticked one.
- One scoped CORS allowance, granted only to origins whose host has a registered, enabled
  channel, with `credentials: 'omit'` so no session could ride along if one existed.

**Still owed:** German copy at length. The report template supports `de` and the schema carries
it, but no German report has been rendered or reviewed, and the embed's own strings are English
only.

## Explicitly not in M3

- **Shopify anything.** → [`optional/SHOPIFY_CONNECTOR.md`](../optional/SHOPIFY_CONNECTOR.md)
- **TREVV handoff.** → [`optional/TREVV_HANDOFF.md`](../optional/TREVV_HANDOFF.md)
- **Venture adapters.** → [`optional/FUTURE_VENTURE_ADAPTERS.md`](../optional/FUTURE_VENTURE_ADAPTERS.md)
- **Agency SaaS, marketplaces, mass crawling, automatic site changes.** →
  [`optional/AGENCY_SAAS_EXPANSION.md`](../optional/AGENCY_SAAS_EXPANSION.md)
- **Outbound campaigns of any kind.** Not deferred — excluded. See
  [the DACH study](../legal/DACH_OUTREACH_STUDY.md): automated cold email to German businesses
  is unlawful under UWG §7(2) Nr. 2, with no B2B exception.

## Gate

Verification abuse and replay; consent never implied; cross-tenant request and report both
refused; expired and revoked shares refused; attacker-controlled redirect refused; request
budget exhaustion bounded; a missing integration reports itself unavailable rather than
degrading; and no live budget spent before a request is verified.
