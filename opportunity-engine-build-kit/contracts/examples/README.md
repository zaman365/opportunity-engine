# Synthetic contract examples

Payloads in this directory are deliberately fictional and are never production seeds. IDs are schema-test UUIDs, domains use `.test`, and no payload proves a completed scan. `index.json` maps files to the domain schema. Run `python scripts/validate-contracts.py` to check positive and negative cases. Authorization, relational consistency, state guards, freshness, counter invariants and commercial permissions remain application/database checks even when a payload passes JSON Schema.
