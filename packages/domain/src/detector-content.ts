/**
 * CE-CONTENT-01 · the page does not tell a buyer something this category requires.
 *
 * Named `PDP-CONTENT-01` in the handoff contract; `@oe/contracts/detector-ids.ts` maps the old
 * spelling onto this one.
 *
 * `contracts/detectors.json` fixes the bar: "Category-specific buying information not found in
 * disclosed inspected sample after module/link checks", abstaining on `sample_incomplete`,
 * `category_unknown` and `hidden_content_not_inspected`. Every word of that is a constraint:
 *
 * - **Category-specific.** There is no general answer to "what must a page say". The answer
 *   comes from an approved rubric (`category-rubric.ts`) and nowhere else. No rubric, no rule.
 * - **Not found in the disclosed inspected sample.** Not "not found on the page". If the rubric
 *   allows an item to live on a linked page, and the scan did not inspect every page the target
 *   linked to, then "missing" is unproven and the rule abstains.
 * - **After module/link checks.** A page that announces a region it did not disclose — a tab, an
 *   accordion, a panel loaded on demand — may well state the item inside it. Captured pages do
 *   not execute, so that content is not readable, and claiming its absence would be claiming
 *   something about a part of the page this system declined to look at.
 *
 * ## What this rule checks, and what it does not
 *
 * It checks that the page **says something** about a required item. It does not check that what
 * it says is any good. A page reading "Material: siehe Etikett" satisfies `materials` here and
 * tells a buyer nothing. Judging adequacy needs a reader, this rule is not a reader, and the
 * limitation is carried into every finding rather than papered over.
 *
 * It also never claims anything in the rubric's `contested` list. Those are the judgements the
 * rubric's author marked as arguable, and they travel into the finding as a stated exclusion so
 * a customer can see exactly what was not judged.
 */

import type { CategoryRubric, ContentItem } from './category-rubric.ts';
import { statesPattern } from './category-rubric.ts';

export const CONTENT_DETECTOR_ID = 'CE-CONTENT-01';
export const CONTENT_DETECTOR_VERSION = '1.0.0';

/** One recorded look at the target page. */
export interface ContentObservation {
  sessionId: string;
  evidenceId: string;
  capturedAt: string;
  target: string;
  contextKey: string;
  /** The page's visible text, flattened. Markup, scripts and styles removed. */
  text: string;
  /**
   * Regions the page announced but did not disclose in this capture: a tab whose panel is
   * empty, a `<details>` with no content, a container that names itself as lazily loaded.
   * Each entry is a short human-readable handle, used only to explain an abstention.
   */
  undisclosedRegions: string[];
  pageComplete: boolean;
  challenge: boolean;
  loginWall: boolean;
}

/** Another page in the same inspected sample, which a required item may be discharged on. */
export interface LinkedPageObservation {
  evidenceId: string;
  url: string;
  text: string;
}

export interface ContentDetectorInput {
  target: string;
  /** Null when no approved rubric covers this target. The rule then has no standard to apply. */
  rubric: CategoryRubric | null;
  observations: ContentObservation[];
  linkedPages: LinkedPageObservation[];
  /**
   * Whether every same-origin page the target linked to was inspected. False means the sample
   * has holes, and an item the rubric allows on a linked page cannot be called missing.
   */
  linkedPagesComplete: boolean;
  now: string;
  maxAgeMs?: number;
}

export type ContentAbstention =
  | 'category_unknown'
  | 'sample_incomplete'
  | 'hidden_content_not_inspected'
  | 'invalid_capture_record'
  | 'insufficient_independent_captures'
  | 'noncomparable_context'
  | 'blocked'
  | 'incomplete_or_ambiguous_capture'
  | 'stale_or_future_capture'
  | 'invalid_freshness_policy'
  | 'content_not_stable_across_captures';

/** What the rule observed about one rubric item, whatever the overall verdict was. */
export interface ItemObservation {
  key: string;
  question: string;
  stated: boolean;
  /** Where it was found: the page itself, or the linked page's URL. */
  statedOn: string | null;
}

export type ContentDetectorResult =
  | {
      result: 'unknown';
      reason: ContentAbstention;
      evidence_ids: string[];
      proposed_grade: null;
      limitations: string[];
      /** Present whenever the rule got far enough to look. A reviewer can still read it. */
      expected_observed?: ItemObservation[];
    }
  | {
      result: 'no_finding';
      reason: 'all_required_buying_information_stated';
      evidence_ids: string[];
      proposed_grade: null;
      limitations: string[];
      expected_observed: ItemObservation[];
    }
  | {
      result: 'candidate';
      reason: 'required_buying_information_not_stated';
      detector_id: string;
      detector_version: string;
      claim: string;
      missing: ItemObservation[];
      expected_observed: ItemObservation[];
      not_judged: string[];
      evidence_ids: string[];
      proposed_grade: 'A';
      requires_human_review: true;
      limitations: string[];
    };

const BASE_LIMITATIONS = [
  'This checks whether the page states something about each item, not whether what it states is adequate. A page that answers the question badly passes this check.',
  'Only the pages in the inspected sample were read. Content elsewhere on the site was not.',
  'Captured pages are not executed, so anything a script would have written is not visible to this check.',
  'The standard applied is the approved category rubric, which is a commercial judgement about this category and not a rule about web pages.',
  'Store-wide scope and revenue impact are unknown.',
];

function abstain(
  reason: ContentAbstention,
  evidenceIds: string[] = [],
  observed?: ItemObservation[],
): ContentDetectorResult {
  return {
    result: 'unknown',
    reason,
    evidence_ids: evidenceIds,
    proposed_grade: null,
    limitations: BASE_LIMITATIONS,
    ...(observed ? { expected_observed: observed } : {}),
  };
}

/** Where an item is stated, if anywhere the sample disclosed. */
function locate(
  item: ContentItem,
  pageText: string,
  linkedPages: LinkedPageObservation[],
): string | null {
  if (item.patterns.some((pattern) => statesPattern(pageText, pattern))) return 'the page itself';
  if (!item.mayBeOnALinkedPage) return null;
  for (const page of linkedPages) {
    if (item.patterns.some((pattern) => statesPattern(page.text, pattern))) return page.url;
  }
  return null;
}

export function evaluateCategoryContent(input: ContentDetectorInput): ContentDetectorResult {
  if (!input || typeof input.target !== 'string' || !input.target.trim()) {
    return abstain('invalid_capture_record');
  }
  // No rubric is not a defect and not an error. It is the rule declining to invent a standard.
  if (input.rubric === null) return abstain('category_unknown');

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
        typeof o.text !== 'string' ||
        !Array.isArray(o.undisclosedRegions),
    )
  ) {
    return abstain('invalid_capture_record');
  }
  if (obs.some((o) => o.target !== input.target)) return abstain('invalid_capture_record');

  const evidenceIds = [
    ...obs.map((o) => o.evidenceId),
    ...input.linkedPages.map((p) => p.evidenceId),
  ];

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

  // Each capture is read on its own, then the readings are compared. A page that states an
  // item in one session and not the next is not a page missing the item — it is a page this
  // rule cannot describe in one sentence, which is a different and honest answer.
  const readings = obs.map((o) =>
    rubric.content.required.map((item) => ({
      key: item.key,
      question: item.questionABuyerAsks,
      statedOn: locate(item, o.text, input.linkedPages),
    })),
  );
  const first = readings[0]!;
  for (const reading of readings.slice(1)) {
    for (const [index, entry] of reading.entries()) {
      if ((entry.statedOn === null) !== (first[index]!.statedOn === null)) {
        return abstain('content_not_stable_across_captures', evidenceIds);
      }
    }
  }

  const required: ItemObservation[] = first.map((entry) => ({
    key: entry.key,
    question: entry.question,
    stated: entry.statedOn !== null,
    statedOn: entry.statedOn,
  }));
  const expectedObserved: ItemObservation[] = rubric.content.expected.map((item) => {
    const where = locate(item, obs[0]!.text, input.linkedPages);
    return {
      key: item.key,
      question: item.questionABuyerAsks,
      stated: where !== null,
      statedOn: where,
    };
  });

  const missing = required.filter((entry) => !entry.stated);
  if (missing.length === 0) {
    return {
      result: 'no_finding',
      reason: 'all_required_buying_information_stated',
      evidence_ids: evidenceIds,
      proposed_grade: null,
      limitations: BASE_LIMITATIONS,
      expected_observed: expectedObserved,
    };
  }

  // From here the rule has something to say, so the reasons it might be wrong are checked —
  // and only now. An undisclosed tab on a page that stated everything anyway changes no
  // answer, and abstaining over it would throw away a correct result.
  const hidden = obs.flatMap((o) => o.undisclosedRegions);
  if (hidden.length > 0)
    return abstain('hidden_content_not_inspected', evidenceIds, expectedObserved);

  const missingKeys = new Set(missing.map((entry) => entry.key));
  const anyCouldBeLinked = rubric.content.required.some(
    (item) => missingKeys.has(item.key) && item.mayBeOnALinkedPage,
  );
  if (anyCouldBeLinked && !input.linkedPagesComplete) {
    return abstain('sample_incomplete', evidenceIds, expectedObserved);
  }

  const names = missing.map((entry) => entry.question);
  return {
    result: 'candidate',
    reason: 'required_buying_information_not_stated',
    detector_id: CONTENT_DETECTOR_ID,
    detector_version: CONTENT_DETECTOR_VERSION,
    claim: `In ${obs.length} recorded checks, the inspected pages did not state ${missing.length === 1 ? 'one thing' : `${missing.length} things`} the "${rubric.label}" rubric requires: ${names.join('; ')}`,
    missing,
    expected_observed: expectedObserved,
    // Carried into the finding so a customer reads what was deliberately not judged, rather
    // than assuming silence meant approval.
    not_judged: rubric.content.contested,
    evidence_ids: evidenceIds,
    proposed_grade: 'A',
    requires_human_review: true,
    limitations: BASE_LIMITATIONS,
  };
}
