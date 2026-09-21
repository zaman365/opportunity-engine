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

## Slice 2 · protected report delivery — **next**

- A report-access grant: random token, stored hashed, audience-bound, short-lived, revocable,
  scoped to **one report version** and nothing else.
- `GET` never mutates. Replay across reports and across tenants both refused.
- No personal data in the URL.
- An invalid, expired or revoked link gets one page that does not leak whether the report ever
  existed, who it belonged to, or why the link stopped working.
- Evidence referenced by a delivered report stays protected: the grant does not open the
  operator's artifact routes.
- English and German templates, both reviewed.

## Slice 3 · embedding the form

- A typed, versioned client for the existing Astro and Next sites, with their branding intact.
- The purpose text a requester agrees to comes from the channel, not from the embedding page,
  and the version they agreed to is recorded with their request.

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
