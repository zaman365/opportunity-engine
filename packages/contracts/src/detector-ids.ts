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
 * The rules this build actually runs.
 *
 * Two of six. The other four are specified in `contracts/detectors.json` and remain
 * unrequestable: one list drives the request contract, admission and the database constraint,
 * so a detector cannot become requestable in one layer and not another.
 */
export const IMPLEMENTED_DETECTORS = ['CE-LINK-01', 'CE-ASSET-01'] as const;
export type ImplementedDetector = (typeof IMPLEMENTED_DETECTORS)[number];

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
