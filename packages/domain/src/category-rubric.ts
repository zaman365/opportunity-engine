/**
 * The category rubric: what a buyer of a particular kind of thing needs a page to tell them.
 *
 * `CE-CONTENT-01` and `CE-VISUAL-01` are the two rules in `contracts/detectors.json` that
 * cannot be written as general rules at all. "This page is missing buying information" is not
 * a statement about pages; it is a statement about *this category of thing*, and the category
 * is a commercial judgement, not a property of the markup. A rule that decided for itself what
 * an overshirt page must say would be enforcing a house style on somebody else's shop under
 * the heading of a defect.
 *
 * So the judgement is moved out of the code and into a file an owner signs, and the code
 * refuses to run without a signature.
 *
 * ## The gate
 *
 * Exactly the arrangement `offer-catalog.ts` already uses for prices. A rubric with no
 * approver is parsed, validated and reported on — and produces nothing usable. It cannot
 * reach `oe.category_rubrics`, so no scan can reference it, so neither detector can be
 * requested. Migration 0017 enforces that end of it as a foreign key rather than trusting
 * this layer; this layer exists so a bad rubric fails with a sentence that names the item,
 * rather than as a constraint violation.
 *
 * ## What a rubric may not do
 *
 * Decide taste. `contested` is the list of things the owner and a colleague would argue
 * about, and nothing in it is ever claimed — it is carried into findings as a stated exclusion
 * so a reader can see what the rule declined to judge. An empty `contested` is rejected: a
 * rubric whose author found nothing arguable has not finished thinking about it.
 */

export type DraftedConfidence = 'high' | 'medium' | 'low';

/** One thing a page either says or does not say. */
export interface ContentItem {
  key: string;
  questionABuyerAsks: string;
  /** Text a page would carry if it states this. Matched case-insensitively, as text. */
  patterns: string[];
  /**
   * Whether a page may discharge this by linking somewhere the scan also inspected. When true
   * and no such page was inspected, the rule abstains rather than calling it missing.
   */
  mayBeOnALinkedPage: boolean;
  /** Present on `required` items only, and read by nobody. Kept so an argument stays visible. */
  draftedConfidence: DraftedConfidence | null;
  whyRequired: string | null;
}

export type ShotDetectability = 'alt text' | 'count only' | 'not detectable';

export interface RequiredShot {
  key: string;
  questionABuyerAsks: string;
  detectableFrom: ShotDetectability;
  altTextPatterns: string[];
}

export interface CategoryRubric {
  key: string;
  label: string;
  whyThisOne: string;
  content: {
    required: ContentItem[];
    expected: ContentItem[];
    contested: string[];
  };
  visual: {
    requiredShots: RequiredShot[];
    minimumProductImages: number;
    needsAHuman: string[];
  };
  approval: {
    approvedBySubject: string;
    approvedAt: string;
    approvalNote: string | null;
  };
}

export interface RubricParseResult {
  /** Non-null only when the rubric is both structurally valid and approved. */
  rubric: CategoryRubric | null;
  /**
   * Every problem, each naming the item it came from. A rubric that is merely unapproved
   * reports that as a problem too: it is the most likely reason a deployment finds these
   * detectors missing, and a silent null would send somebody looking in the wrong place.
   */
  problems: string[];
  /**
   * True when the only thing wrong is the missing signature. Callers that legitimately expect
   * an unapproved rubric — the seeder, the readiness endpoint — use this to tell "nobody has
   * signed it yet" apart from "it is malformed", which are different situations.
   */
  unapprovedOnly: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((item) => nonEmptyString(item) !== null) ? (value as string[]) : null;
}

/** An ISO instant, not a date. An approval that happened on a day did not happen at a time. */
function instant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : value;
}

function parseContentItem(
  raw: unknown,
  where: string,
  required: boolean,
  problems: string[],
): ContentItem | null {
  const record = asRecord(raw);
  if (!record) {
    problems.push(`${where} must be an object.`);
    return null;
  }
  const key = nonEmptyString(record['key']);
  if (key === null || !/^[a-z0-9_]+$/.test(key)) {
    problems.push(
      `${where}.key must be a lowercase identifier (got ${JSON.stringify(record['key'])}).`,
    );
    return null;
  }
  const question = nonEmptyString(record['question_a_buyer_asks']);
  if (question === null) {
    problems.push(
      `${where} (${key}) must state question_a_buyer_asks. An item nobody asks about is not buying information.`,
    );
  }
  const patterns = stringArray(record['how_a_page_states_it']);
  if (patterns === null) {
    problems.push(
      `${where} (${key}) must list how_a_page_states_it. The rule matches text; with no text to match it would abstain on every page, which is worse than not having the item.`,
    );
  }
  // A placeholder that reached a deployment would produce findings about pages that failed to
  // say "FILL IN". Rejecting the literal is cheaper than explaining that finding later.
  for (const value of [question, ...(patterns ?? [])]) {
    if (value !== null && value.includes('FILL IN')) {
      problems.push(`${where} (${key}) still carries a template placeholder.`);
      break;
    }
  }
  let whyRequired: string | null = null;
  if (required) {
    whyRequired = nonEmptyString(record['why_required']);
    if (whyRequired === null) {
      problems.push(
        `${where} (${key}) must state why_required. "Required" without a reason is taste with a stronger word.`,
      );
    }
  }
  const confidence = record['drafted_confidence'];
  if (confidence !== undefined && !['high', 'medium', 'low'].includes(confidence as string)) {
    problems.push(`${where} (${key}).drafted_confidence must be high | medium | low when present.`);
  }
  if (question === null || patterns === null) return null;
  return {
    key,
    questionABuyerAsks: question,
    patterns,
    mayBeOnALinkedPage: record['may_be_on_a_linked_page'] === true,
    draftedConfidence: (confidence as DraftedConfidence | undefined) ?? null,
    whyRequired,
  };
}

function parseShot(raw: unknown, index: number, problems: string[]): RequiredShot | null {
  const record = asRecord(raw);
  if (!record) {
    problems.push(`visual.required_shots[${index}] must be an object.`);
    return null;
  }
  const key = nonEmptyString(record['key']);
  const question = nonEmptyString(record['question_a_buyer_asks']);
  const detectable = record['detectable_from'];
  if (key === null || question === null) {
    problems.push(`visual.required_shots[${index}] must have key and question_a_buyer_asks.`);
    return null;
  }
  if (detectable !== 'alt text' && detectable !== 'count only' && detectable !== 'not detectable') {
    problems.push(
      `visual.required_shots[${index}] (${key}).detectable_from must be "alt text" | "count only" | "not detectable".`,
    );
    return null;
  }
  const patterns = Array.isArray(record['alt_text_patterns'])
    ? (record['alt_text_patterns'] as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  // The one combination that cannot mean anything: claim it is readable from alt text, then
  // give nothing to read. It would silently never match and look like a clean page.
  if (detectable === 'alt text' && patterns.length === 0) {
    problems.push(
      `visual.required_shots[${index}] (${key}) is marked detectable from alt text but lists no alt_text_patterns.`,
    );
    return null;
  }
  return {
    key,
    questionABuyerAsks: question,
    detectableFrom: detectable,
    altTextPatterns: patterns,
  };
}

export function parseCategoryRubric(raw: unknown): RubricParseResult {
  const problems: string[] = [];
  const doc = asRecord(raw);
  if (!doc)
    return { rubric: null, problems: ['A rubric must be a JSON object.'], unapprovedOnly: false };

  const category = asRecord(doc['category']);
  const key = category ? nonEmptyString(category['key']) : null;
  const label = category ? nonEmptyString(category['label']) : null;
  const whyThisOne = category ? nonEmptyString(category['why_this_one']) : null;
  if (key === null || !/^[a-z0-9-]+$/.test(key)) {
    problems.push(
      `category.key must be a lowercase slug (got ${JSON.stringify(category?.['key'])}).`,
    );
  }
  if (label === null) problems.push('category.label is required.');
  if (whyThisOne === null) {
    problems.push(
      'category.why_this_one is required. A rubric for a category nobody sells into cannot be validated against anything.',
    );
  }

  const content = asRecord(doc['content']);
  const rawRequired = content && Array.isArray(content['required']) ? content['required'] : null;
  const rawExpected = content && Array.isArray(content['expected']) ? content['expected'] : [];
  if (rawRequired === null || rawRequired.length === 0) {
    problems.push(
      'content.required must list at least one item. A rubric that requires nothing can produce no finding.',
    );
  }
  const required = (rawRequired ?? [])
    .map((item, index) => parseContentItem(item, `content.required[${index}]`, true, problems))
    .filter((item): item is ContentItem => item !== null);
  const expected = rawExpected
    .map((item, index) => parseContentItem(item, `content.expected[${index}]`, false, problems))
    .filter((item): item is ContentItem => item !== null);

  const contested = content ? stringArray(content['contested']) : null;
  if (contested === null) {
    problems.push(
      'content.contested must list at least one item. A rubric whose author found nothing arguable has not finished; every finding carries this list as what the rule declined to judge.',
    );
  } else if (contested.some((entry) => entry.includes('FILL IN'))) {
    problems.push('content.contested still carries a template placeholder.');
  }

  const keys = new Set<string>();
  for (const item of [...required, ...expected]) {
    if (keys.has(item.key))
      problems.push(`content item "${item.key}" appears twice. One item, one tier.`);
    keys.add(item.key);
  }

  const visual = asRecord(doc['visual']);
  const rawShots =
    visual && Array.isArray(visual['required_shots']) ? visual['required_shots'] : [];
  const requiredShots = rawShots
    .map((shot, index) => parseShot(shot, index, problems))
    .filter((shot): shot is RequiredShot => shot !== null);
  const minimum = visual?.['minimum_product_images'];
  if (typeof minimum !== 'number' || !Number.isInteger(minimum) || minimum < 0) {
    problems.push(
      'visual.minimum_product_images must be a nonnegative integer. Zero is allowed and means "do not count".',
    );
  }
  const needsAHuman = visual ? stringArray(visual['needs_a_human']) : null;
  if (needsAHuman === null) {
    problems.push(
      'visual.needs_a_human must list at least one item. This rule has no vision model; a rubric claiming everything about images is machine-checkable is wrong about this system.',
    );
  }

  const approval = asRecord(doc['approval']);
  const approvedBy = approval ? nonEmptyString(approval['approved_by_subject']) : null;
  const approvedAt = approval ? instant(approval['approved_at']) : null;
  const structurallyValid = problems.length === 0;

  if (approvedBy === null || approvedAt === null) {
    problems.push(
      `Rubric "${key ?? 'unknown'}" has no owner approval, so CE-CONTENT-01 and CE-VISUAL-01 stay unrequestable. Set approval.approved_by_subject and approval.approved_at once somebody has read it and stands behind it.`,
    );
    return { rubric: null, problems, unapprovedOnly: structurallyValid };
  }

  if (problems.length > 0) return { rubric: null, problems, unapprovedOnly: false };

  return {
    rubric: {
      key: key!,
      label: label!,
      whyThisOne: whyThisOne!,
      content: { required, expected, contested: contested! },
      visual: { requiredShots, minimumProductImages: minimum as number, needsAHuman: needsAHuman! },
      approval: {
        approvedBySubject: approvedBy,
        approvedAt,
        approvalNote: approval ? nonEmptyString(approval['approval_note']) : null,
      },
    },
    problems: [],
    unapprovedOnly: false,
  };
}

/**
 * Case-insensitive, whitespace-tolerant text match.
 *
 * Deliberately not a word-boundary match: `% Baumwolle` and `14 Tage Rückgaberecht` are
 * patterns with punctuation and digits in them, and a boundary rule would drop them.
 */
export function statesPattern(haystack: string, pattern: string): boolean {
  const normalise = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalise(haystack).includes(normalise(pattern));
}
