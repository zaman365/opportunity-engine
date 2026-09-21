# Offer pricing · proposal for approval

**Proposal, 21 September 2026. Nothing here is enabled.**

You asked me to set prices. I can do the analysis, but the kit is explicit that price is an
owner decision — `config/offer-catalog.json` ships every SKU with `enabled: false` and
`price_minor: null`, and `npm run kit:check` fails if that changes without approval. So this is
a proposal with the reasoning shown. Say a number and I will wire it; say nothing and the
catalogue stays disabled and the engine routes everything to manual quotation.

## The arithmetic that matters

The kit's contribution model, applied to what the engine can currently produce:

```
contribution per order = net price − delivery cost
break-even orders      = fixed monthly cost ÷ contribution per order
```

The trap it warns about: "A low scan cost does not imply low service cost." A scan that costs
€0.00 on Cloudflare's free tier can still take you 90 minutes of review and repair. **Price the
hour, not the compute.**

## What the engine can actually sell today

Two detectors produce confirmed findings: a broken information link, and a product image that
does not load. Both are narrow, both are provable, and both map to a small bounded repair.

That is a genuine constraint on pricing. You cannot charge audit-package money for a report
that says "one link is broken" — but you can charge properly for fixing it, because the
evidence removes the diagnosis time that normally makes small jobs unprofitable.

## MF-LINK-REPAIR · bounded repair of one root cause

**Proposed: €290 net, fixed.** Kit's illustrative range: €190–€590.

|                                |                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Promise                        | Repair one supported information-link or asset root cause and verify the corrected destination under the same recorded conditions |
| Includes                       | One agreed link or asset family; staging test where available; before/after evidence at matching viewport, locale and variant     |
| Excludes                       | New content or photography; site redesign; platform reinstatement; any revenue guarantee                                          |
| Prerequisites                  | Authorised code or platform access; agreed destination; scope approval                                                            |
| Realistic effort               | 1–3 hours including verification                                                                                                  |
| Contribution at €60/h internal | €110–€230                                                                                                                         |

**Why €290 rather than €190.** At €190 a job that runs to three hours contributes €10. The
floor has to survive the bad case, not the good one. €290 stays comfortably inside what a
merchant will pay without a procurement conversation, and it is cheap relative to the
alternative — which is that they never find out at all.

**Why not €590.** That is a price for a diagnosed _and scoped_ problem where you have already
proven you can deliver. You have not delivered one yet.

## PDP-REVIEWED-AUDIT · reviewed assessment of an agreed sample

**Proposed: €190 net, credited in full against a repair booked within 30 days.**
Kit's illustrative range: €149–€249.

|                                |                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Promise                        | A human-reviewed assessment of an agreed page sample, with evidence, limitations and a prioritised brief |
| Includes                       | Up to three agreed pages or one template family; evidence-backed findings; specialist review             |
| Excludes                       | New photography; model or location licensing; implementation; any causal revenue claim                   |
| Realistic effort               | 45–75 minutes review, once the engine has done collection                                                |
| Contribution at €60/h internal | €115–€145                                                                                                |

**Why the credit.** It converts the audit from a purchase into a first step, and it is the
honest version of a discount: you are not giving work away, you are moving the money to the
job that actually fixes something. The kit warns against "routinely delivering extensive unpaid
expert work" — a credited paid audit is the opposite of that.

**Cap the credit at one repair.** Otherwise a customer buys one audit and credits it against
three jobs.

## What is missing before either can be enabled

1. **A delivered example.** You have never repaired a link for a paying customer. Until you
   have, the effort estimates above are assumptions, and the kit is right that assumptions are
   not prices.
2. **Acceptance tests per SKU.** "Approved destination loads in recorded conditions; no
   regression in supported fixture; customer or authorised lead accepts." These exist as text
   in the catalogue and as nothing in code.
3. **Capacity.** An offer consumes delivery hours, not just compute. With one person, two
   concurrent repairs is a realistic ceiling; the engine should refuse to draft a third rather
   than quote a date you will miss.
4. **VAT treatment.** Net prices above. Whether you charge German VAT depends on your
   registration and the customer's status. Not my call and not a guess I will make.

## On "keep it password protected"

I read your note as: the operator interface stays private to you, and prices are not published
anywhere public yet. Both are how it is built — the UI goes behind Cloudflare Access with a
single-identity policy, and the catalogue is disabled so no price can reach a customer surface.

If you also meant `marktfix.com` itself should be gated, say so: that is a separate site and a
separate Access policy, and I would want to know whether it is meant to stay unreachable or
just unindexed.

## What I need from you

- **Two numbers** — or "use your proposal", in which case I will wire €290 and €190 and mark
  them `provisional` in the catalogue with your approval recorded against them.
- **Your internal hourly rate**, if €60 is wrong. Every contribution figure above moves with it.
- **Whether the audit credit applies**, and whether it caps at one repair.
- **VAT**: net or gross, and whether you are charging it.

Until those land, the catalogue stays `enabled: false` and every confirmed finding routes to
manual quotation — which is the correct behaviour, not a placeholder.
