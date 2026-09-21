# Architecture decision records

`opportunity-engine-build-kit/docs/architecture/DECISIONS.md` holds ADR-001 to ADR-009,
accepted as the kit's starting shape. These files continue that sequence with decisions the
application itself forced, using the format that document specifies: ID and date, observed
problem, decision, alternatives rejected, affected contracts, security and cost implications,
migration and rollback, verification, and status.

| ADR | Decision | Status |
|---|---|---|
| [ADR-010](ADR-010-toolchain.md) | Pinned toolchain: TypeScript 6.0.3, Vite 8, React 19, Hono 4 | Accepted |
| [ADR-011](ADR-011-domain-port.md) | Port the kit's reference logic to TypeScript with a parity test | Accepted |
| [ADR-012](ADR-012-ledger-in-sql.md) | Budget writes only through SQL command functions | Accepted |
| [ADR-013](ADR-013-identity-lookup.md) | One narrow RLS policy for membership resolution | Accepted |
| [ADR-014](ADR-014-dispatch-index.md) | Cross-tenant dispatch through a routing index, not BYPASSRLS | Accepted |
| [ADR-015](ADR-015-two-target-policies.md) | A separate fixture target policy rather than a relaxed production one | Accepted |
| [ADR-016](ADR-016-composition.md) | Case composition: the observation matrix leads | Provisional |
