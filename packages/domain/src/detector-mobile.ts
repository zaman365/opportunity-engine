/**
 * CE-MOBILE-01 · something is covering the page at a phone viewport.
 *
 * Named `PDP-MOBILE-01` in the handoff contract; `@oe/contracts/detector-ids.ts` maps the old
 * spelling onto this one.
 *
 * `contracts/detectors.json` fixes the bar: "Actual obstruction at recorded viewport with
 * DOM/image evidence and repeated state", abstaining on `user_dismissible_overlay_not_tested`,
 * `transient_loading` and `missing_viewport`.
 *
 * Three things make this rule narrower than it sounds, and all three are in the specification:
 *
 * - **Actual obstruction.** Not "there is a sticky bar" — bars are normal. An obstruction is
 *   an element that covers a material share of the viewport *and* overlaps the content the
 *   page is about. A 48-pixel header does neither.
 * - **Repeated state.** The same element, covering the same region, in two independent
 *   sessions. A cookie bar that appears once and not again is not a persistent obstruction.
 * - **Not dismissible, or not known to be.** An overlay with a visible close control might
 *   vanish on the first tap. This rule does not tap anything, so it cannot tell — and says so
 *   rather than guessing.
 *
 * ## What this rule cannot see
 *
 * The capture path runs with JavaScript disabled, deliberately: a captured page must not be
 * able to execute. Most real interstitials — consent managers, chat widgets, app-install
 * prompts — are injected by scripts and are therefore **invisible to this rule entirely**.
 * What it does see is what the server sent: CSS-positioned bars and overlays present in the
 * initial HTML, which is a real and common category but far from all of them.
 *
 * That is a limitation of the rule, not a bug in it, and it is stated in every finding.
 */

export const MOBILE_DETECTOR_ID = 'CE-MOBILE-01';
export const MOBILE_DETECTOR_VERSION = '1.0.0';

/** A box in CSS pixels, relative to the viewport. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One element the page positions over its own content. */
export interface OverlayObservation {
  /** A stable handle for the element across sessions: its tag, id and classes. */
  key: string;
  /** `fixed` or `sticky`. Anything else is not an overlay. */
  position: 'fixed' | 'sticky';
  rect: Rect;
  /** A visible control inside it that looks like a way to close it. */
  hasDismissControl: boolean;
  /** The element or an ancestor announces itself as a loading state. */
  looksTransient: boolean;
}

export interface MobileObservation {
  sessionId: string;
  evidenceId: string;
  capturedAt: string;
  target: string;
  contextKey: string;
  viewport: { width: number; height: number } | null;
  /** The region the page's own content occupies, when it can be established. */
  contentRect: Rect | null;
  overlays: OverlayObservation[];
  pageComplete: boolean;
  challenge: boolean;
  loginWall: boolean;
}

export interface MobileDetectorInput {
  target: string;
  observations: MobileObservation[];
  now: string;
  maxAgeMs?: number;
}

export type MobileAbstention =
  | 'insufficient_independent_captures'
  | 'invalid_capture_record'
  | 'incomplete_or_ambiguous_capture'
  | 'blocked'
  | 'missing_viewport'
  | 'user_dismissible_overlay_not_tested'
  | 'transient_loading'
  | 'content_region_not_established'
  | 'not_a_phone_viewport'
  | 'noncomparable_context'
  | 'stale_or_future_capture'
  | 'invalid_freshness_policy'
  | 'obstruction_not_repeated';

export type MobileDetectorResult =
  | {
      result: 'unknown';
      reason: MobileAbstention;
      evidence_ids: string[];
      proposed_grade: null;
      limitations: string[];
    }
  | {
      result: 'no_finding';
      reason: 'no_persistent_obstruction_at_this_viewport';
      evidence_ids: string[];
      proposed_grade: null;
      limitations: string[];
    }
  | {
      result: 'candidate';
      reason: 'persistent_obstruction';
      detector_id: string;
      detector_version: string;
      claim: string;
      evidence_ids: string[];
      proposed_grade: 'A';
      requires_human_review: true;
      limitations: string[];
    };

/**
 * A phone, for this rule's purposes.
 *
 * 480 CSS pixels is the widest a device that behaves like a phone reports. Wider than that and
 * "obstruction at a phone viewport" is not what was measured, so the rule declines rather than
 * reporting a desktop observation under a mobile heading.
 */
const MAX_PHONE_WIDTH = 480;

/**
 * How much of the viewport an element has to cover before it is an obstruction.
 *
 * A quarter. A 48-pixel sticky header on an 812-pixel screen is 6% and is normal furniture; a
 * consent bar that takes a third of the screen is not. The threshold is deliberately generous
 * to the page: being wrong in this direction misses a real obstruction, and being wrong in the
 * other tells a shop their normal header is a defect.
 */
const MIN_VIEWPORT_SHARE = 0.25;

/** And it has to be over the content, not beside it. */
const MIN_CONTENT_OVERLAP = 0.1;

const BASE_LIMITATIONS = [
  'Only the recorded phone viewport was tested. A different screen size may behave differently.',
  'Nothing was tapped, scrolled past or dismissed: this is what the page presented on arrival.',
  'Elements added by JavaScript are not visible to this check, because captured pages are not executed. Most consent and chat overlays are added that way.',
  'Store-wide scope and revenue impact are unknown.',
];

const abstain = (reason: MobileAbstention, evidenceIds: string[] = []): MobileDetectorResult => ({
  result: 'unknown',
  reason,
  evidence_ids: evidenceIds,
  proposed_grade: null,
  limitations: [
    'This rule reports what covered the page as the server sent it. It does not establish that a visitor could not proceed.',
    ...BASE_LIMITATIONS,
  ],
});

function area(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersection(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** Is this element covering enough of the screen, and enough of the content, to matter? */
function obstructs(
  overlay: OverlayObservation,
  viewport: { width: number; height: number },
  content: Rect,
): boolean {
  const viewportArea = viewport.width * viewport.height;
  if (viewportArea <= 0) return false;
  // Clipped to the viewport: an element hanging off the screen only obstructs what is on it.
  const visible: Rect = {
    x: Math.max(0, overlay.rect.x),
    y: Math.max(0, overlay.rect.y),
    width:
      Math.min(overlay.rect.x + overlay.rect.width, viewport.width) - Math.max(0, overlay.rect.x),
    height:
      Math.min(overlay.rect.y + overlay.rect.height, viewport.height) - Math.max(0, overlay.rect.y),
  };
  if (area(visible) / viewportArea < MIN_VIEWPORT_SHARE) return false;
  const contentArea = area(content);
  if (contentArea <= 0) return false;
  return intersection(visible, content) / contentArea >= MIN_CONTENT_OVERLAP;
}

export function evaluateMobileObstruction(input: MobileDetectorInput): MobileDetectorResult {
  if (!input || typeof input.target !== 'string' || !input.target.trim()) {
    return abstain('invalid_capture_record');
  }
  if (!Array.isArray(input.observations) || input.observations.length < 2) {
    return abstain('insufficient_independent_captures');
  }
  const obs = input.observations;
  if (obs.some((o) => !o || typeof o.sessionId !== 'string' || typeof o.evidenceId !== 'string')) {
    return abstain('invalid_capture_record');
  }
  if (obs.some((o) => o.target !== input.target)) return abstain('invalid_capture_record');

  const evidenceIds = obs.map((o) => o.evidenceId);

  if (new Set(obs.map((o) => o.sessionId)).size < 2) {
    return abstain('insufficient_independent_captures');
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

  // Without a recorded viewport there is no "at this screen size" to report.
  if (obs.some((o) => o.viewport === null || o.viewport.width <= 0 || o.viewport.height <= 0)) {
    return abstain('missing_viewport', evidenceIds);
  }
  const viewport = obs[0]!.viewport!;
  if (obs.some((o) => o.viewport!.width !== viewport.width)) {
    return abstain('noncomparable_context', evidenceIds);
  }
  // A desktop measurement reported under a mobile heading would be a different claim from
  // the one this rule makes.
  if (viewport.width > MAX_PHONE_WIDTH) return abstain('not_a_phone_viewport', evidenceIds);

  if (obs.some((o) => o.contentRect === null)) {
    return abstain('content_region_not_established', evidenceIds);
  }

  // The same element, obstructing, in every session. An overlay seen once is not persistent.
  const obstructingKeys = obs.map(
    (o) =>
      new Set(
        o.overlays
          .filter((overlay) => obstructs(overlay, viewport, o.contentRect!))
          .map((v) => v.key),
      ),
  );
  const persistent = [...obstructingKeys[0]!].filter((key) =>
    obstructingKeys.every((keys) => keys.has(key)),
  );

  if (persistent.length === 0) {
    // Distinguish "nothing covered it" from "something did, but not every time". The second
    // is a different answer and a reviewer may want to look.
    const anywhere = obstructingKeys.some((keys) => keys.size > 0);
    if (anywhere) return abstain('obstruction_not_repeated', evidenceIds);
    return {
      result: 'no_finding',
      reason: 'no_persistent_obstruction_at_this_viewport',
      evidence_ids: evidenceIds,
      proposed_grade: null,
      limitations: [
        'Nothing covered the page in the recorded checks at this viewport. That is a result about this page and this screen size.',
        ...BASE_LIMITATIONS,
      ],
    };
  }

  const first = obs[0]!;
  const offenders = persistent
    .map((key) => first.overlays.find((overlay) => overlay.key === key)!)
    .filter(Boolean);

  // A loading state that has not finished is not an obstruction a visitor would live with.
  if (offenders.some((overlay) => overlay.looksTransient)) {
    return abstain('transient_loading', evidenceIds);
  }
  // It might close on the first tap. This rule does not tap anything, so it cannot say.
  if (offenders.some((overlay) => overlay.hasDismissControl)) {
    return abstain('user_dismissible_overlay_not_tested', evidenceIds);
  }

  const viewportArea = viewport.width * viewport.height;
  const share = Math.round((area(offenders[0]!.rect) / viewportArea) * 100);

  return {
    result: 'candidate',
    reason: 'persistent_obstruction',
    detector_id: MOBILE_DETECTOR_ID,
    detector_version: MOBILE_DETECTOR_VERSION,
    claim: `A ${offenders[0]!.position} element covered about ${share}% of the ${viewport.width}×${viewport.height} viewport, over the page's own content, in ${obs.length} recorded checks. It carried no visible way to close it.`,
    evidence_ids: evidenceIds,
    proposed_grade: 'A',
    requires_human_review: true,
    limitations: [
      'This says something covered the page on arrival. It does not establish that a visitor could not scroll past it or proceed.',
      ...BASE_LIMITATIONS,
    ],
  };
}
