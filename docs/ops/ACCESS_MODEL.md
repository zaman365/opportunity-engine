# Who gets access, at what level

**Analysis and recommendation, 21 September 2026.** You asked me to make logical decisions
here, so I have. Each one is reversible and each says what would change my mind.

## The four gates, restated

The kit separates four things that are easy to conflate. All four must pass:

1. **Identity** — who are you (Cloudflare Access verifies this)
2. **Membership** — do you belong to this workspace, and which ventures
3. **Role** — does your role permit this _kind_ of action
4. **Purpose permission** — is there a current, scoped authorization for this action on this
   _object_

A role never substitutes for an authorization. An owner still cannot scan a host the account
has not approved.

## Recommendation for today

You are one person. The honest membership table is one row.

| Identity | Role      | Why                                                             |
| -------- | --------- | --------------------------------------------------------------- |
| you      | **owner** | Everything is your decision, and there is nobody to delegate to |

Do **not** create the other three roles yet. Empty roles invite the habit of signing in as
whoever is convenient, and the audit trail stops meaning anything the moment two people share
an identity.

### But keep operating in two habits, not one

The roles exist to separate _starting a check_ from _standing behind its result_. With one
person that separation is a discipline rather than a technical control — but it is still worth
keeping, because it is what makes the review step real rather than a rubber stamp:

- When you run a scan, you are acting as operator. Do not decide it in the same sitting.
- When you confirm a finding, you are the reviewer and your name is bound to that exact
  version, permanently, in `oe.reviews`.

If that feels like theatre with one person: it is not. The finding you confirm is the claim you
will put in front of a paying customer, and the version binding is what protects you if they
dispute it later.

## When to add each role

| Add          | When                                                                                                      | What they get                                                                | What they still cannot do                                   |
| ------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **viewer**   | You want to show someone the work — an advisor, a prospective partner, a client looking at their own case | Read accounts, scans, evidence, reports                                      | Start anything, decide anything, see another tenant         |
| **operator** | Someone else runs checks for you — a VA, a junior                                                         | Create and cancel scans in assigned ventures                                 | Confirm a finding, publish a report, change a limit         |
| **reviewer** | Someone else is qualified to judge evidence                                                               | Everything an operator can, plus confirm/reject findings and publish reports | Change cost limits, create accounts, record authorizations  |
| **owner**    | A genuine co-owner of the business                                                                        | Everything, including limits, accounts and authorizations                    | Nothing in-app; still cannot make an unlawful action lawful |

**The role to be slowest about is reviewer.** Operator mistakes are visible and cheap — a
wasted scan. A reviewer mistake is a false claim delivered to a customer under your name.

## Venture scoping

Membership is scoped per venture, not just per workspace. Today there is one venture
(`marktfix`). When you add PDP Studio or another brand, assign people per venture rather than
giving everyone everything — a contractor working on photography has no business reading a
technical client's scan history.

## The one genuinely hard case

**A client who wants to see their own case.** They are not a `viewer` in your workspace —
giving them a membership would let them see every other account in it. That is what M3's
separate report-access token exists for: a short-lived, hashed, audience-bound link to one
report version, revocable, with no operator session attached.

Do not solve this by creating viewer memberships for clients. It is the single most likely way
this system leaks one customer's data to another.

## How membership is actually created

Not through the API. ROLES_PERMISSIONS.md requires an audited bootstrap outside the public
surface, and the code enforces it: the runtime database role has no INSERT on `oe.memberships`.
Adding a person is a deliberate migration-role operation against a verified identity — which is
the point. There is no self-signup and no invite flow, and there should not be one before M3.

## Concrete next actions

1. **You**: create the Cloudflare Zero Trust organisation and add exactly one Access policy —
   your email, nothing else. That is the "password protect it so only I can access it" you
   asked for, done properly: identity-verified, not a shared password.
2. **Me**: write the owner-bootstrap procedure as a reviewed script so adding a person is a
   recorded act rather than a hand-typed SQL statement. Small, and it belongs before anyone
   else ever gets access.
3. **Later, before the first client**: the M3 report-access token, so you can show a customer
   their own report without giving them a seat.

## What would change my mind

- If you take on a delivery partner before M3, operator + reviewer become real and the
  one-row table is wrong.
- If an advisor needs standing read access, add a viewer — it costs nothing and the audit
  trail stays clean.
- If you ever find yourself about to share your own credentials with somebody: that is the
  signal to add a role, not to share.
