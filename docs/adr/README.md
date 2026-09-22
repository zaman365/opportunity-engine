# Architecture decision records

`opportunity-engine-build-kit/docs/architecture/DECISIONS.md` holds ADR-001 to ADR-009,
accepted as the kit's starting shape. These files continue that sequence with decisions the
application itself forced, using the format that document specifies: ID and date, observed
problem, decision, alternatives rejected, affected contracts, security and cost implications,
migration and rollback, verification, and status.

| ADR                                       | Decision                                                                 | Status      |
| ----------------------------------------- | ------------------------------------------------------------------------ | ----------- |
| [ADR-010](ADR-010-toolchain.md)           | Pinned toolchain: TypeScript 6.0.3, Vite 8, React 19, Hono 4             | Accepted    |
| [ADR-011](ADR-011-domain-port.md)         | Port the kit's reference logic to TypeScript with a parity test          | Accepted    |
| [ADR-012](ADR-012-ledger-in-sql.md)       | Budget writes only through SQL command functions                         | Accepted    |
| [ADR-013](ADR-013-identity-lookup.md)     | One narrow RLS policy for membership resolution                          | Accepted    |
| [ADR-014](ADR-014-dispatch-index.md)      | Cross-tenant dispatch through a routing index, not BYPASSRLS             | Accepted    |
| [ADR-015](ADR-015-two-target-policies.md) | A separate fixture target policy rather than a relaxed production one    | Accepted    |
| [ADR-016](ADR-016-composition.md)         | Case composition: the observation matrix leads                           | Provisional |
| [ADR-017](ADR-017-asset-detector.md)      | MF-ASSET-01 needs a browser, and its own fixtures                        | Accepted    |
| [ADR-018](ADR-018-contract-overlay.md)    | Generate the served contract from the handoff plus an overlay            | Accepted    |
| [ADR-019](ADR-019-offer-catalog.md)       | Scope from a catalogue, price from an owner, neither from the code       | Accepted    |
| [ADR-020](ADR-020-requested-intake.md)    | A request is not permission, and the host decides the workspace          | Accepted    |
| [ADR-021](ADR-021-product-direction.md)   | The Brand Consistency Scanner, and a roadmap that supersedes the handoff | Accepted    |
| [ADR-022](ADR-022-report-delivery.md)     | A protected link is not a seat                                           | Accepted    |
| [ADR-023](ADR-023-engagements.md)         | Acceptance is a recorded act, not a payment event                        | Accepted    |
| [ADR-024](ADR-024-data-detector.md)       | CE-DATA-01 abstains wherever tax, currency or variant could explain it   | Accepted    |
| [ADR-025](ADR-025-mobile-detector.md)     | CE-MOBILE-01, and the bug that made healthy images look broken           | Accepted    |
| [ADR-026](ADR-026-german-copy.md)         | The frame is translated; a confirmed claim is not                        | Accepted    |
| [ADR-027](ADR-027-category-rubric.md)     | Draft the category rubric, build both rules, lock them in the database   | Accepted    |
