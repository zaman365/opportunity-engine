/**
 * CE-VISUAL-01 · the image sequence does not answer what a buyer of this thing needs to see.
 *
 * Named `PDP-VISUAL-01` in the handoff contract; `@oe/contracts/detector-ids.ts` maps the old
 * spelling onto this one.
 *
 * `contracts/detectors.json` fixes the bar: "Real image sequence fails a specific category
 * buying-question rubric; specialist review", abstaining on `missing_images`,
 * `subjective_style_preference_only` and `unsupported_category`.
 *
 * ## The thing to understand before reading the code
 *
 * **This rule cannot see what is in a photograph.** There is no vision model in this system,
 * and putting one here would mean a machine asserting what a picture shows, in a document whose
 * entire value is that every claim in it was checked. So the rule works with the two things a
 * captured page actually discloses about its own images: how many there are, and what the page
 * says each one is.
 *
 * That yields exactly two kinds of claim, and they are not equally strong, so they do not carry
 * the same grade:
 *
 * - **A count.** "Fewer images than this category's floor" is arithmetic over recorded evidence,
 *   as objective as a 404. Grade A.
 * - **A gap in declared coverage.** "No image is described as showing the back" rests on alt
 *   text, and alt text is missing or careless on plenty of pages that photograph a garment from
 *   every angle. The absence of a description is not the absence of a photograph. Grade B --
 *   which by `checkActionReadiness` cannot be published until a specialist has looked, and
 *   "specialist review" is precisely what the contract asks for here.
 *
 * Anything the rubric marks `not detectable`, and everything under `needs_a_human`, is never
 * claimed. It travels with the result as an open question for a person.
 */

import type { CategoryRubric, RequiredShot } from './category-rubric.ts';
import { statesPattern } from './category-rubric.ts';

export const VISUAL_DETECTOR_ID = 'CE-VISUAL-01';
export const VISUAL_DETECTOR_VERSION = '1.0.0';

/** One image the page presents as being about the product. */
export interface ProductImageObservation {
  evidenceId: string;
  src: string;
  /** Exactly what the page declared. Empty string is a real answer: "this says nothing". */
  alt: string;
  /** `alt=""` with a presentational role. Excluded from the count; it is not a product shot. */
  decorative: boolean;
  /** Whether the image rendered. A broken image is CE-ASSET-01's business, not this rule's. */
  rendered: boolean;
}

export interface VisualObservation {
  sessionId: string;
  evidenceId: string;
  capturedAt: string;
  target: string;
  contextKey: string;
  images: ProductImageObservation[];
  pageComplete: boolean;
  challenge: boolean;
  loginWall: boolean;
}

export interface VisualDetectorInput {
  target: string;
  rubric: CategoryRubric | null;
  observations: VisualObservation[];
  now: string;
  maxAgeMs?: number;
}

export type VisualAbstention =
  | 'unsupported_category'
  | 'missing_images'
  | 'subjective_style_preference_only'
  | 'invalid_capture_record'
  | 'insufficient_independent_captures'
  | 'noncomparable_context'
  | 'blocked'
  | 'incomplete_or_ambiguous_capture'
  | 'stale_or_future_capture'
  | 'invalid_freshness_policy'
  | 'image_set_not_stable_across_captures'
  | 'shot_coverage_not_declared';

export interface ShotObservation {
  key: string;
  question: string;
  /** Null when the rubric says this shot type cannot be read from a captured page at all. */
  declared: boolean | null;
}

export type VisualDetectorResult =
  | {
      result: 'unknown';
      reason: VisualAbstention;
      evidence_ids: string[];
      proposed_grade: null;
      limitations: string[];
      open_questions?: string[];
    }
  | {
      result: 'no_finding';
      reason: 'image_sequence_meets_category_rubric';
      evidence_ids: string[];
      proposed_grade: null;
      limitations: string[];
      open_questions: string[];
    }
  | {
      result: 'candidate';
      reason: 'below_minimum_image_count' | 'declared_shot_coverage_incomplete';
      detector_id: string;
      detector_version: string;
      claim: string;
      image_count: number;
      shots: ShotObservation[];
      /** Never claims. Recorded so a specialist knows what the rule deliberately left alone. */
      open_questions: string[];
      not_judged: string[];
      evidence_ids: string[];
      /** A counted shortfall is confirmed evidence; a gap in alt text is not. */
      proposed_grade: 'A' | 'B';
      requires_human_review: true;
      limitations: string[];
    };

const BASE_LIMITATIONS = [
  'Nothing in this system looks at what a photograph shows. This check counts the images a page presented and reads what the page said each one was.',
  'Alt text is a description the page chose to write. Its absence is not evidence that a photograph is absent.',
  'Only the recorded captures of the inspected page were read.',
  'The standard applied is the approved category rubric, which is a commercial judgement about this category and not a rule about web pages.',
  'Store-wide scope and revenue impact are unknown.',
];

function abstain(
  reason: VisualAbstention,
  evidenceIds: string[] = [],
  openQuestions?: string[],
): VisualDetectorResult {
  return {
    result: 'unknown',
    reason,
    evidence_ids: evidenceIds,
    proposed_grade: null,
    limitations: BASE_LIMITATIONS,
    ...(openQuestions ? { open_questions: openQuestions } : {}),
  };
}

/** A product shot, for counting: presented as being about the product, and actually there. */
function counts(image: ProductImageObservation): boolean {
  return !image.decorative && image.rendered;
}

function declaresShot(shot: RequiredShot, images: ProductImageObservation[]): boolean {
  return images.some((image) =>
    shot.altTextPatterns.some((pattern) => statesPattern(image.alt, pattern)),
  );
}

export function evaluateVisualRubric(input: VisualDetectorInput): VisualDetectorResult {
  if (!input || typeof input.target !== 'string' || !input.target.trim()) {
    return abstain('invalid_capture_record');
  }
  if (input.rubric === null) return abstain('unsupported_category');

  if (!Array.isArray(input.observations) || input.observations.length < 2) {
    return abstain('insufficient_independent_captures');
  }
  const obs = input.observations;
  if (
    obs.some(
      (o) =>
        !o ||
        typeof o.sessionId !== 'string' ||
        typeof o.evidenceId !== 'string' ||
        !Array.isArray(o.images),
    )
  ) {
    return abstain('invalid_capture_record');
  }
  if (obs.some((o) => o.target !== input.target)) return abstain('invalid_capture_record');

  const evidenceIds = obs.map((o) => o.evidenceId);

  if (new Set(obs.map((o) => o.sessionId)).size < 2) {
    return abstain('insufficient_independent_captures', evidenceIds);
  }
  if (new Set(obs.map((o) => o.contextKey)).size !== 1) {
    return abstain('noncomparable_context', evidenceIds);
  }
  if (obs.some((o) => o.challenge || o.loginWall)) return abstain('blocked', evidenceIds);
  if (obs.some((o) => !o.pageComplete)) {
    return abstain('incomplete_or_ambiguous_capture', evidenceIds);
  }

  const maxAgeMs = input.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return abstain('invalid_freshness_policy');
  const now = Date.parse(input.now);
  if (Number.isNaN(now)) return abstain('invalid_freshness_policy');
  for (const o of obs) {
    const at = Date.parse(o.capturedAt);
    if (Number.isNaN(at) || at > now || now - at > maxAgeMs) {
      return abstain('stale_or_future_capture', evidenceIds);
    }
  }

  const rubric = input.rubric;
  const openQuestions = rubric.visual.needsAHuman;

  // The same page serving a different gallery to different sessions is a page this rule cannot
  // describe in one sentence. Compared by src set, not by count: two captures that happen to
  // show three different images each are not the same evidence.
  const sets = obs.map((o) =>
    JSON.stringify([...new Set(o.images.filter(counts).map((image) => image.src))].sort()),
  );
  if (sets.some((set) => set !== sets[0])) {
    return abstain('image_set_not_stable_across_captures', evidenceIds, openQuestions);
  }

  const images = obs[0]!.images.filter(counts);
  const imageCount = new Set(images.map((image) => image.src)).size;

  // Nothing to judge. Distinguished from "too few" because a page with no product imagery at
  // all is usually a capture problem or a page this scan misidentified, not a merchandising
  // decision somebody made.
  if (imageCount === 0) return abstain('missing_images', evidenceIds, openQuestions);

  const shots: ShotObservation[] = rubric.visual.requiredShots.map((shot) => ({
    key: shot.key,
    question: shot.questionABuyerAsks,
    declared: shot.detectableFrom === 'not detectable' ? null : declaresShot(shot, images),
  }));

  const belowMinimum = imageCount < rubric.visual.minimumProductImages;
  const undeclared = shots.filter((shot) => shot.declared === false);

  if (belowMinimum) {
    return {
      result: 'candidate',
      reason: 'below_minimum_image_count',
      detector_id: VISUAL_DETECTOR_ID,
      detector_version: VISUAL_DETECTOR_VERSION,
      claim: `The page presented ${imageCount} product image${imageCount === 1 ? '' : 's'} in ${obs.length} recorded checks. The "${rubric.label}" rubric sets ${rubric.visual.minimumProductImages} as the floor for this category.`,
      image_count: imageCount,
      shots,
      open_questions: openQuestions,
      not_judged: rubric.content.contested,
      evidence_ids: evidenceIds,
      // Arithmetic over recorded evidence. A reviewer is confirming the rubric's floor, not
      // the count.
      proposed_grade: 'A',
      requires_human_review: true,
      limitations: BASE_LIMITATIONS,
    };
  }

  if (undeclared.length === 0) {
    // Everything the rule can read is present. What remains is what only an eye can settle,
    // and the rule says so rather than implying the imagery is good.
    return {
      result: 'no_finding',
      reason: 'image_sequence_meets_category_rubric',
      evidence_ids: evidenceIds,
      proposed_grade: null,
      limitations: BASE_LIMITATIONS,
      open_questions: openQuestions,
    };
  }

  // A page whose images carry no descriptions at all cannot have its shot coverage read, and
  // saying "no image shows the back" of such a page would be describing the alt text while
  // appearing to describe the photographs. That the alt text is missing is CE-ASSET-01's
  // business; here it is simply a reason this rule cannot answer.
  if (images.every((image) => image.alt.trim() === '')) {
    return abstain('shot_coverage_not_declared', evidenceIds, openQuestions);
  }

  // What is left is a real gap in what the page declared -- declared, not photographed.
  // Grade B keeps it out of a published report until a specialist has actually looked at the
  // images, which is the review the contract asks for.
  const names = undeclared.map((shot) => shot.question);
  return {
    result: 'candidate',
    reason: 'declared_shot_coverage_incomplete',
    detector_id: VISUAL_DETECTOR_ID,
    detector_version: VISUAL_DETECTOR_VERSION,
    claim: `Across ${imageCount} product images in ${obs.length} recorded checks, none was described as answering ${undeclared.length === 1 ? 'one question' : `${undeclared.length} questions`} the "${rubric.label}" rubric requires: ${names.join('; ')}. This is about what the page said its images show, not about what they show.`,
    image_count: imageCount,
    shots,
    open_questions: openQuestions,
    not_judged: rubric.content.contested,
    evidence_ids: evidenceIds,
    proposed_grade: 'B',
    requires_human_review: true,
    limitations: BASE_LIMITATIONS,
  };
}
