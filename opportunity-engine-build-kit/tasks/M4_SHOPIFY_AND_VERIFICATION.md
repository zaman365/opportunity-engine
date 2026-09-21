# M4 · one authorized account connector

## Outcome

Read a customer's authorized Shopify product data and verify a delivered improvement under recorded conditions.

## Tasks

Check current official Shopify API/OAuth docs; decide app distribution with owner. Request only required read scopes, tenant-bind OAuth state, validate callback and store tokens encrypted. Record scope/expiry/revocation and controller purpose. Use product/variant IDs to correlate public observation, not guessed titles. No order/customer data without separately justified scope.

Implement verification runs linked to engagement/acceptance test, before/after matching viewport/locale/variant/consent and changed-artifact lineage. Record observed improvement, not causal revenue uplift. Customer or authorized lead accepts the completed work separately from automatic detector output.

## Tests/gate

Wrong tenant/account callback; revoked/expired token; scope reduction; uninstall deletion; rate-limit/retry; pagination; partial data; mismatched product variant; already-fixed defect; non-comparable captures; failed acceptance; no production write from read token. Real authorized connector test is required before claiming connected.
