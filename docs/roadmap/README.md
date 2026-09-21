# Roadmap

The milestone set for the **Brand Consistency Scanner**. This supersedes
`opportunity-engine-build-kit/tasks/`, which stays byte-identical as the record of what the
handoff actually said — see [ADR-021](../adr/ADR-021-product-direction.md) for why the kit is
not edited in place.

| Milestone                                     | Outcome                                                       | State           |
| --------------------------------------------- | ------------------------------------------------------------- | --------------- |
| [M0](M0_FOUNDATION.md)                        | Foundation: config, roles, tenancy, budgets, contracts        | **Complete**    |
| [M1](M1_SCAN_TO_REPORT_JOURNEY.md)            | One real journey: scan → evidence → review → protected report | **Complete**    |
| [M2](M2_CONSISTENCY_DETECTORS.md)             | Consistency detectors with negative controls                  | **2 of 6**      |
| [M3](M3_PUBLIC_INTAKE_AND_REPORT_DELIVERY.md) | Public intake and protected report delivery                   | **In progress** |
| [M4](M4_OFFERS_AND_SERVICE_SCOPE.md)          | Offers and accepted service scope                             | Partly built    |
| [M5](M5_MONITORING_AND_OPERATIONS.md)         | Monitoring and operations                                     | Not started     |
| [M6](M6_PILOT_VALIDATION.md)                  | Pilot validation                                              | Not started     |

## What changed from the handoff's milestone set

| Handoff                       | Now                                                                 | Why                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `M1_ONE_REAL_JOURNEY`         | `M1_SCAN_TO_REPORT_JOURNEY`                                         | Same scope, named for what it produces                                                                               |
| `M2_DETECTORS_AND_OFFERS`     | `M2_CONSISTENCY_DETECTORS` + `M4_OFFERS_...`                        | Detectors and commerce were one milestone doing two jobs. The offer catalogue is already built; it is M4's scope now |
| `M3_CUSTOMER_AND_ENGAGEMENTS` | `M3_PUBLIC_INTAKE_AND_REPORT_DELIVERY`                              | The engagement half moved to M4. M3 is intake and delivery, which is one coherent thing                              |
| `M4_SHOPIFY_AND_VERIFICATION` | [`optional/SHOPIFY_CONNECTOR.md`](../optional/SHOPIFY_CONNECTOR.md) | A connector to one commerce platform is not a milestone of a scanner                                                 |
| `M5_MONITORING_AND_TREVV`     | `M5_MONITORING_AND_OPERATIONS`                                      | Monitoring is core. TREVV is [optional](../optional/TREVV_HANDOFF.md)                                                |
| `M6_PILOT_AND_EXPANSION`      | `M6_PILOT_VALIDATION`                                               | "Expansion" carried the agency-SaaS framing; that is [optional](../optional/AGENCY_SAAS_EXPANSION.md)                |

## Work already done that sits outside its milestone

Two things were built before this roadmap existed and are complete:

- **The offer catalogue** (M4's first slice) landed during M2, because M2's handoff scope
  included it. See [ADR-019](../adr/ADR-019-offer-catalog.md).
- **Requested intake** (M3's first slice) is done. See
  [ADR-020](../adr/ADR-020-requested-intake.md).

Recording that here rather than renumbering the commits: the history says what happened, and
the roadmap says what is left.
