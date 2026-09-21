# Deployment on the Cloudflare free tier

**Verified against Cloudflare's own docs, 21 September 2026.** I assumed the free plan would
block live capture. It does not. Here is what I actually checked and what it means.

## What the free plan gives you

| Service                     | Free-plan limit                                                                                         | Verified at                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Browser Run**             | 10 minutes browser time **per day**; 3 concurrent browsers; 1 new instance per 20s; 60s browser timeout | `developers.cloudflare.com/browser-rendering/platform/limits/` |
| **Hyperdrive**              | 100,000 database queries per day                                                                        | `developers.cloudflare.com/hyperdrive/platform/pricing/`       |
| **Zero Trust (Access)**     | Free plan available; payment details required at signup, not charged                                    | `developers.cloudflare.com/cloudflare-one/setup/`              |
| **Workers + static assets** | Free plan                                                                                               | —                                                              |
| **R2**                      | Free tier storage                                                                                       | Not re-verified; confirm before relying on it                  |

### What 10 minutes a day actually buys

One scan captures four pages — source and destination, twice each — plus its image
subresources. Measured locally that is roughly 10–15 seconds of browser time.

**≈ 40 live scans per day.** For a pilot where every finding gets human review, 40 is far more
than one reviewer can process. Browser time is not your bottleneck; your attention is.

The 3-concurrent-browser limit matches the kit's own ceiling of one concurrent browser per
host, so it constrains nothing we intended to do.

## The one thing Cloudflare does not provide

**PostgreSQL.** Hyperdrive is a connection pooler to a database hosted elsewhere, not a
database. So you need one, and this is the only real decision in the stack:

| Option                         | Cost                       | Notes                                                                                     |
| ------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------- |
| **Neon free tier**             | €0                         | EU region available. Scales to zero, so first query after idle is slow. Fine for a pilot. |
| **Supabase free tier**         | €0                         | EU region available. Includes things we do not need.                                      |
| **PlanetScale via Cloudflare** | Pay-as-you-go from day one | Billed on your Cloudflare invoice. Not free.                                              |
| **A small managed instance**   | ~€7–15/mo                  | Predictable, no cold starts                                                               |

**Recommendation: Neon free tier, EU region (Frankfurt).** ADR-003 requires "an owner-approved
EU region", and the cold-start penalty is irrelevant when a human reviews every result. Moving
later is a connection-string change.

One caution the kit raises and I will repeat: an EU database does not make the whole system
EU-only. Browser Run, Workers and logs run on Cloudflare's global network. Record storage
region separately from processing geography, and do not claim EU-only processing.

## What this stack costs at pilot scale

**€0/month**, with these ceilings:

- 40 live scans/day
- 100k database queries/day
- Zero Trust free plan for access control

The first thing that would have exceeded this was the dispatcher itself. It polled once a
second while idle — ~86,000 ticks a day, three statements each, **~259,000 queries/day before a
single scan ran**. Fixed: it now backs off exponentially to a 15-second ceiling when the queue
is empty, which is ~17,000 queries/day. Local development overrides the ceiling to 750ms via
`RUNNER_IDLE_MAX_MS` so there is no wait between clicking scan and seeing it run.

## Sequence, and who does what

| #   | Step                                                                                                                                                       | Who                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Create the Zero Trust organisation; one Access policy, your email only                                                                                     | **You**                    |
| 2   | Create the Neon database, EU region; hand me nothing — put the URL straight into Cloudflare as a secret                                                    | **You**                    |
| 3   | ~~Fix the dispatcher poll interval~~ — done                                                                                                                | Me, done                   |
| 4   | Write `wrangler.toml`, the Worker entry and the Hyperdrive/R2/Browser Run bindings                                                                         | Me                         |
| 5   | Implement the Browser Run capture adapter (ADR-005 increment 5)                                                                                            | Me                         |
| 6   | **Prove the egress boundary** — private, loopback, link-local and metadata addresses must be unreachable from a capture, on redirects and subresources too | Me, with evidence recorded |
| 7   | Run migrations against the staging database as the migration role                                                                                          | Me, you approve            |
| 8   | Record `marktfix.com` as an approved account with a written authorization                                                                                  | You approve, me record     |
| 9   | First live scan of a page you own                                                                                                                          | Together                   |

**Steps 1 and 2 are yours and I cannot do them.** I will not hold Cloudflare or database
credentials; they belong in Cloudflare's secret store, entered by you.

**Step 6 is the gate.** ADR-005 keeps live capture blocked until the deny-private-network
boundary is demonstrated and recorded — not asserted. Until that evidence exists,
`BrowserRunCaptureProvider` keeps reporting `not_configured`, which is the correct behaviour.

## What stays off

`PUBLIC_INTAKE_ENABLED`, `AUTOMATIC_OUTREACH_ENABLED`, `AUTOMATIC_PRODUCTION_WRITES_ENABLED`
and `AUTOMATIC_TOPUPS_ENABLED` are all refused at startup. Public intake turns on in M3 behind
abuse controls. Outreach does not turn on at all — see
[the DACH study](../legal/DACH_OUTREACH_STUDY.md) for why that is now a legal control and not
just a design preference.

## Domains

- `brandwaveltd.com` — the Cloudflare account's zone
- `marktfix.com` — resolves, already behind Cloudflare
- `marktfix.co` — **does not resolve.** Your message linked to `.com`, so I have taken `.com`
  as the intended scan target. Correct me if not.

Suggested operator hostname: `oe.brandwaveltd.com`, behind Access, never indexed. Keeping the
tool on the holding company's domain rather than a venture's keeps the shared-infrastructure
boundary visible — which matters once a second venture uses it.
