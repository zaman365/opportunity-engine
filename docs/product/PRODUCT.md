# Brand Consistency Scanner

**The product.** A focused scanner for websites, product pages, landing pages, brand pages and
business pages. It scans an approved URL, records what it actually observed, asks a person
whether that evidence supports a claim, and turns confirmed claims into a protected report.

**The capability underneath it** is the **Consistency Engine**: evidence capture, detector
execution, finding review, report generation, and — later — monitoring and integrations.

The distinction matters for one practical reason. The scanner is a product somebody buys. The
engine is a capability that may power more than one scanner surface. Anything named after the
engine (the `CE-` detector namespace, `packages/domain`, `packages/capture`) is written to be
reusable; anything named after a venture is not, which is why the detector namespace moved.

## What it is not

The repository directory is still called `opportunity-engine` and the handoff kit it was built
from describes a broader multi-venture platform. That framing is superseded. This is **not**:

- a TREVV task system
- a Shopify app or connector
- a LokalFix, MikroIT or other venture-specific tool
- a MarktFix-only or PDP-Studio-only tool
- an agency SaaS platform, marketplace or data-licensing business
- a general "opportunity engine" or multi-venture operating system

Each of those either belongs to a later, optional integration — see [`docs/optional`](../optional/)
— or is out of scope entirely. None of them is being built here, and no code in this repository
implements any of them.

## The shape of the thing

```
scan an approved URL
  → capture evidence in two independent comparable sessions
  → run consistency detectors over what was recorded
  → a person reviews each candidate against its evidence
  → confirmed claims become a protected, versioned report
  → optionally, a service scope at an owner-approved price
```

Every arrow is a refusal point. A scan refuses an unapproved host. A detector abstains rather
than guessing. A confirmation refuses without supporting, unexpired, uncontradicted evidence. A
report refuses to publish from a stale finding version. A scope refuses a price no owner
approved. The product is those refusals as much as it is the scan.

## Detector namespace

The Consistency Engine's detectors are `CE-`. The venture-scoped names the handoff used are
still accepted on the wire and still readable in old records:

| Consistency Engine | Handoff name     | Built |
| ------------------ | ---------------- | ----- |
| `CE-LINK-01`       | `MF-LINK-01`     | yes   |
| `CE-ASSET-01`      | `MF-ASSET-01`    | yes   |
| `CE-DATA-01`       | `MF-DATA-01`     | no    |
| `CE-CONTENT-01`    | `PDP-CONTENT-01` | no    |
| `CE-VISUAL-01`     | `PDP-VISUAL-01`  | no    |
| `CE-MOBILE-01`     | `PDP-MOBILE-01`  | no    |

Nothing already written down was renamed. A finding carries the id it was produced under, and
a reviewer confirmed that claim under that id — rewriting it afterwards would change what
somebody signed. See [ADR-021](../adr/ADR-021-product-direction.md).

## Roadmap

[`docs/roadmap`](../roadmap/) holds the current milestone set and supersedes
`opportunity-engine-build-kit/tasks/`. The kit stays byte-identical as the record of what the
handoff actually said.
