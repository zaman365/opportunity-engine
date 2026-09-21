# Optional · Shopify connector

**Not implemented. Not in any current milestone.** The handoff had this as
`M4_SHOPIFY_AND_VERIFICATION`; it is optional work now.

## What it would be

An authorized, read-only Shopify integration: OAuth with minimal scopes, encrypted store
tokens, product and theme reads, and before/after verification of a repair against the store's
own data rather than against a rendered page.

## Why it is not a milestone of this product

The Brand Consistency Scanner works on **pages**, from the outside, with an owner's
permission. That is what makes it applicable to any site. A connector to one commerce platform
would make the most valuable path through the product available only to merchants on that
platform, and would change what the thing is.

It is also a large security surface for a capability nothing currently needs: OAuth token
storage and rotation, scope minimisation, revocation handling, webhook signature verification
and replay protection, and an app review. None of that is hard in isolation; all of it is
permanent.

## What would have to be true first

1. Pilot customers are predominantly on Shopify **and** ask for it by name.
2. A specific check is impossible from the outside and worth having from the inside. "Richer
   data" is not that; a concrete detector that cannot otherwise exist is.
3. A security review of token storage, scope minimisation and revocation, before any code.
4. Read-only is genuinely enough. Read access must not become authority to change data,
   install apps or incur charges — the handoff is right about that and it is easy to drift.

## What it must never become

An automatic writer. `AUTOMATIC_PRODUCTION_WRITES_ENABLED` is refused at startup and should
stay refused. A connector that can fix a store on its own is a different product with
different liability.
