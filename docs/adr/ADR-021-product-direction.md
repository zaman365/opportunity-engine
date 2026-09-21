# ADR-021 · The Brand Consistency Scanner, and a roadmap that supersedes the handoff

**2026-09-21 · accepted**

## Problem

The owner set the product direction explicitly: this is the **Brand Consistency Scanner**,
powered by the **Consistency Engine**. It is not a TREVV task system, a Shopify app, a
LokalFix or MikroIT tool, a MarktFix-only or PDP-Studio-only tool, a generic "opportunity
engine", or a multi-venture operating system.

That is a narrowing, and it contradicts the framing of the handoff kit this repository was
built from — which describes a shared engine for several ventures, has Shopify as a milestone,
TREVV inside another, and names detectors after the ventures they were written for.

Two things needed deciding. Where the new direction lives, given the kit is integrity-recorded
and its own `AGENTS.md` says to treat it as read-only. And what to do about identifiers already
written into a database.

## Decision

### The roadmap lives in the repository; the kit stays byte-identical

`docs/product/PRODUCT.md`, `docs/roadmap/` and `docs/optional/` are authoritative.
`opportunity-engine-build-kit/` is unchanged apart from `PROGRESS.md`, which the kit itself
instructs agents to update.

This follows the pattern ADR-018 established for the contract, for the same reason it worked
there: the handoff's value after it has been superseded is as **the record of what the handoff
actually said**. Renaming `tasks/M3_CUSTOMER_AND_ENGAGEMENTS.md` inside it would destroy that
record and the `SHA256SUMS` line that proves it, and six months from now nobody would be able
to tell what was originally specified from what was decided later. Each superseding document
names the kit file it replaces and says what changed and why.

The owner asked for the file to be renamed. This achieves the rename — the milestone is now
`docs/roadmap/M3_PUBLIC_INTAKE_AND_REPORT_DELIVERY.md` and it is the one anybody works from —
without losing the provenance. If the preference is to rewrite inside the kit and re-record
the hashes instead, that is a small change and this ADR is the thing to revisit.

### Milestones restructured

| Handoff                       | Now                                    | Change                                                               |
| ----------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| `M1_ONE_REAL_JOURNEY`         | `M1_SCAN_TO_REPORT_JOURNEY`            | Renamed for what it produces                                         |
| `M2_DETECTORS_AND_OFFERS`     | `M2_CONSISTENCY_DETECTORS` + `M4`      | Split: one milestone was doing two jobs                              |
| `M3_CUSTOMER_AND_ENGAGEMENTS` | `M3_PUBLIC_INTAKE_AND_REPORT_DELIVERY` | Engagements moved to M4; M3 is intake and delivery                   |
| `M4_SHOPIFY_AND_VERIFICATION` | `optional/SHOPIFY_CONNECTOR.md`        | A connector to one commerce platform is not a milestone of a scanner |
| `M5_MONITORING_AND_TREVV`     | `M5_MONITORING_AND_OPERATIONS`         | Monitoring is core; TREVV is an optional internal integration        |
| `M6_PILOT_AND_EXPANSION`      | `M6_PILOT_VALIDATION`                  | "Expansion" carried the agency-SaaS framing                          |

Four bodies of work moved to `docs/optional/`: the Shopify connector, the TREVV handoff,
future venture adapters, and agency SaaS. Each file records the idea, the cost, and the
condition that would have to hold before it became worth doing. Two of them — mass crawling
and data licensing — are recorded as contrary to what the product is rather than merely
deferred, because they would abandon the permission model the whole evidentiary standing of
this system rests on.

### The detector namespace is `CE-`, and nothing already recorded was renamed

`MF-LINK-01` → `CE-LINK-01`, `MF-ASSET-01` → `CE-ASSET-01`, and the same for the four
specified-but-unbuilt rules. The canonical list and the mapping live in
`packages/contracts/src/detector-ids.ts` — in `@oe/contracts` rather than `@oe/domain`, because
the browser bundle needs it and may not import `@oe/domain`.

The rename is applied in three different ways, on purpose:

**Configuration is normalised.** `oe.offers.detector_families`,
`oe.intake_channels.allowed_detectors`, `oe.scans.detectors` and the scan allowlist constraint
all move to `CE-` in migration 0011. These are settings — what a SKU answers, what a form
offers, what a scan asked for — and rewriting them changes nothing anybody claimed. The column
default moves with the constraint, because a default and a check that disagree is a trap for
whoever writes the next migration.

**Evidence is not touched.** `oe.findings.detector_id` keeps whatever it was written with. A
reviewer confirmed _that_ claim under _that_ id at _that_ version, bound in `oe.reviews`.
Rewriting it afterwards would change what somebody signed — quietly, and after the fact. The
application compares canonically instead, so an old finding and a new catalogue entry answer
as the same rule.

**Input accepts both.** `CreateScan.detectors` takes either namespace and the API canonicalises
before it writes. Widening what is accepted can break no client; narrowing it would break
anyone still sending `MF-LINK-01`. Every comparison in the system — offer matching, a channel's
offered checks, scan admission, the UI's interpretation text — goes through `sameDetector` or
`canonicalDetectorId`, so the two spellings cannot drift into meaning different things.

## Alternatives rejected

- **Editing the kit in place.** Destroys the integrity record and the ability to tell later
  what the handoff specified. The overlay pattern exists precisely because this trade-off came
  up before.
- **A hard rename of `oe.findings.detector_id`.** It would alter confirmed claims. Whatever
  else a rename is worth, it is not worth that, and a system that rewrites evidence to tidy a
  namespace has stopped being evidence-first.
- **Accepting only `CE-` ids.** Breaks any client written against the handoff contract for no
  benefit: the mapping is four lines and the comparison is one function.
- **Renaming `MF-LINK-01` without bumping the detector version.** Considered and kept: the
  rule is unchanged, so the version should be, and the alias records the equivalence. The
  parity test asserts exactly this — that the only difference between this build and the
  reference module is the detector id, with every other field identical.
- **Deleting the deferred work rather than documenting it.** A deferred idea that is not
  written down gets re-proposed by whoever last read the handoff.

## Affected contracts

`CreateScan.detectors` widens to accept both namespaces (overlay 2.4.0); the document's
description now names the product, the capability and both spellings. `DetectorId` in
`@oe/contracts` becomes `RequestedDetectorId` and is generated from `ACCEPTED_DETECTOR_IDS`, so
the enum cannot drift from the implemented list.

## Migration and rollback

`packages/db/migrations/0011_detector_namespace.sql` rewrites three configuration columns,
moves the scan allowlist constraint and its default, and leaves findings alone. Rolling back
means reversing the mapping in those columns; nothing else depends on the direction.

The repository directory is still called `opportunity-engine` and the git remote still points
at `zaman365/opportunity-engine`. Renaming those is a separate, disruptive act — it breaks
existing clones and links — and it is the owner's to take, so it has not been assumed here.

## Verification

- `tests/unit/intake.test.ts` — the mapping in both directions, an unknown id staying unknown,
  both spellings accepted for built rules and neither for unbuilt ones, and two end-to-end
  cases: a catalogue entry written in the old namespace matching a finding written in the new,
  and a public form configured in the old namespace offering a check requested in the new.
- `tests/unit/reference-parity.test.ts` — parity normalised on the detector id, plus an
  assertion that the id is the _only_ field that differs from the reference module.
- The db, integration and e2e suites exercise the normalised columns and the canonicalised
  admission path throughout.

## Status

**Accepted.** The product direction is the owner's decision and is recorded as given. The
judgement calls that are mine — leaving the kit byte-identical, and not rewriting recorded
findings — are stated above with their reasons, and both are cheap to reverse.
