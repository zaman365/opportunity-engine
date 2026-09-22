/**
 * Detector identifiers, and what the old ones mean now.
 *
 * The rules were first named after the ventures they were written for — `MF-` for MarktFix,
 * `PDP-` for PDP Studio. The product they belong to is the **Brand Consistency Scanner**, and
 * the capability underneath it is the **Consistency Engine**, which may power more than one
 * scanner surface. So the canonical namespace is `CE-`.
 *
 * This module lives in `@oe/contracts` rather than `@oe/domain` because both sides of the wire
 * need it, including the browser bundle — which may not import `@oe/domain` at all (see the
 * `no-restricted-imports` rule in eslint.config.js).
 *
 * **Nothing here renames anything already written down.** A finding carries the detector id it
 * was produced under, and a reviewer confirmed *that* claim under *that* id; rewriting it later
 * would change what somebody signed. Old spellings stay valid input and stay readable output,
 * and every comparison goes through `canonicalDetectorId` so the two namespaces answer as one.
 */

export const DETECTOR_IDS = [
  'CE-LINK-01',
  'CE-ASSET-01',
  'CE-DATA-01',
  'CE-CONTENT-01',
  'CE-VISUAL-01',
  'CE-MOBILE-01',
] as const;

export type DetectorId = (typeof DETECTOR_IDS)[number];

/** The venture-scoped spellings, and the Consistency Engine rule each one names. */
export const LEGACY_DETECTOR_IDS: Readonly<Record<string, DetectorId>> = {
  'MF-LINK-01': 'CE-LINK-01',
  'MF-ASSET-01': 'CE-ASSET-01',
  'MF-DATA-01': 'CE-DATA-01',
  'PDP-CONTENT-01': 'CE-CONTENT-01',
  'PDP-VISUAL-01': 'CE-VISUAL-01',
  'PDP-MOBILE-01': 'CE-MOBILE-01',
};

/** Canonical id for either spelling, or null if it names no rule this build knows. */
export function canonicalDetectorId(id: string): DetectorId | null {
  if ((DETECTOR_IDS as readonly string[]).includes(id)) return id as DetectorId;
  return LEGACY_DETECTOR_IDS[id] ?? null;
}

/** True when two ids name the same rule, whichever namespace each is written in. */
export function sameDetector(a: string, b: string): boolean {
  const left = canonicalDetectorId(a);
  return left !== null && left === canonicalDetectorId(b);
}

/**
 * The rules this build actually runs without further permission.
 *
 * Four of six. `CE-CONTENT-01` and `CE-VISUAL-01` are written and tested, but both apply a
 * **category rubric** — what a buyer of a particular kind of thing needs a page to tell them —
 * and that is a commercial judgement an owner signs, not a property of markup this build gets
 * to decide. `config/category-rubric.json` holds a draft with no signature on it, so neither
 * rule can be requested; migration 0017 enforces that as a foreign key rather than trusting
 * this list.
 *
 * So "implemented" and "requestable" have come apart, and the two are kept apart deliberately:
 * one list drives the request contract, admission and the database constraint, and a detector
 * must not become requestable in one layer and not another.
 */
export const IMPLEMENTED_DETECTORS = [
  'CE-LINK-01',
  'CE-ASSET-01',
  'CE-DATA-01',
  'CE-MOBILE-01',
] as const;
export type ImplementedDetector = (typeof IMPLEMENTED_DETECTORS)[number];

/**
 * Written, tested, and held shut behind an approved rubric.
 *
 * Here rather than in `@oe/domain` for the same reason as everything else in this module: the
 * operator bundle needs to explain *why* a rule is not on offer, and "not built yet" and
 * "waiting on a judgement somebody owes us" are different sentences to put in front of a user.
 */
export const RUBRIC_GATED_DETECTORS = ['CE-CONTENT-01', 'CE-VISUAL-01'] as const;
export type RubricGatedDetector = (typeof RUBRIC_GATED_DETECTORS)[number];

/** True when a rule exists but is waiting on an owner-approved category rubric. */
export function isRubricGated(id: string): boolean {
  const canonical = canonicalDetectorId(id);
  return canonical !== null && (RUBRIC_GATED_DETECTORS as readonly string[]).includes(canonical);
}

/**
 * Every spelling a caller may send for an implemented rule.
 *
 * Both namespaces, because a client written against the handoff contract must keep working:
 * widening what is accepted can break nobody, and narrowing it would break anyone still
 * sending `MF-LINK-01`.
 */
export const ACCEPTED_DETECTOR_IDS: readonly string[] = [
  ...IMPLEMENTED_DETECTORS,
  ...Object.keys(LEGACY_DETECTOR_IDS).filter((legacy) =>
    (IMPLEMENTED_DETECTORS as readonly string[]).includes(LEGACY_DETECTOR_IDS[legacy]!),
  ),
];

export function isImplementedDetector(id: string): boolean {
  const canonical = canonicalDetectorId(id);
  return canonical !== null && (IMPLEMENTED_DETECTORS as readonly string[]).includes(canonical);
}
