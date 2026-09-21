/**
 * Opportunity Engine reference model, 2026-09-21.
 * Pure functions; no requests, persistent state, billing or legal determinations.
 * Run tests: node --test reference/scoring.test.mjs
 */
export const WEIGHTS = Object.freeze({ fit: 25, need: 30, deliverability: 20, timing: 15, value: 10 });

function fraction(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number between 0 and 1.`);
  }
  return value;
}
function nonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite nonnegative number.`);
  }
  return value;
}
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * @param {{fit: number|null, need: number|null, deliverability: number|null,
 * timing: number|null, value: number|null}} dimensions
 * Missing (undefined) inputs are rejected; use explicit null for unknown.
 */
export function scoreOpportunity(dimensions) {
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) {
    throw new TypeError('An object with all five dimension keys is required.');
  }
  const unexpected = Object.keys(dimensions).filter(key => !Object.hasOwn(WEIGHTS, key));
  if (unexpected.length) throw new TypeError(`Unknown dimensions: ${unexpected.join(', ')}`);
  let lower = 0;
  let knownWeight = 0;
  const components = {};
  const unknown = [];
  for (const [name, weight] of Object.entries(WEIGHTS)) {
    if (!Object.hasOwn(dimensions, name) || dimensions[name] === undefined) {
      throw new TypeError(`Missing dimension ${name}; use null to represent unknown.`);
    }
    const value = dimensions[name];
    if (value === null) {
      unknown.push(name);
      components[name] = { weight, value: null, contribution: null };
    } else {
      fraction(value, name);
      lower += weight * value;
      knownWeight += weight;
      components[name] = { weight, value, contribution: round(weight * value) };
    }
  }
  const upper = lower + 100 - knownWeight;
  return {
    modelVersion: 'priority-v1',
    pointScore: unknown.length ? null : round(lower),
    lowerBound: round(lower), upperBound: round(upper),
    weightedCoverage: knownWeight / 100,
    rankable: unknown.length === 0,
    unknown, components,
    interpretation: 'Internal priority index; not a purchase probability.'
  };
}

/**
 * @param {{rootCauseKey: string, severity: number}[]} findings
 * Only feed current, confirmed findings into this function. It cannot verify evidence.
 */
export function aggregateNeed(findings) {
  if (!Array.isArray(findings)) throw new TypeError('findings must be an array.');
  const groups = new Map();
  for (const item of findings) {
    if (!item || typeof item.rootCauseKey !== 'string' || !item.rootCauseKey.trim()) {
      throw new TypeError('Each finding requires a nonempty rootCauseKey.');
    }
    const severity = fraction(item.severity, 'severity');
    groups.set(item.rootCauseKey, Math.max(groups.get(item.rootCauseKey) ?? 0, severity));
  }
  const descending = [...groups.values()].sort((a, b) => b - a);
  return {
    need: round(Math.min(1, (descending[0] ?? 0) + .25 * (descending[1] ?? 0) + .1 * (descending[2] ?? 0))),
    rootCauseCount: groups.size,
    suppliedFindingCount: findings.length
  };
}

/**
 * A fail-closed readiness helper, NOT a legal decision engine.
 * It consumes a previously reviewed policy record whose action scope and expiry match.
 * @param {{action: 'publish_report'|'contact'|'change', evidenceGrade: 'A'|'B'|'C',
 * evidenceFresh: boolean, humanApproved: boolean, budgetAvailable: boolean,
 * policyRecord: {decision: 'allow'|'deny'|'unknown', action: string,
 * version: string, expiresAt: string}|null, now?: string}} input
 */
export function checkActionReadiness(input) {
  if (!input || !['publish_report', 'contact', 'change'].includes(input.action)) {
    throw new TypeError('A supported action is required.');
  }
  if (!['A', 'B', 'C'].includes(input.evidenceGrade)) throw new TypeError('Invalid evidence grade.');
  for (const key of ['evidenceFresh', 'humanApproved', 'budgetAvailable']) {
    if (typeof input[key] !== 'boolean') throw new TypeError(`${key} must be boolean.`);
  }
  const now = Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(now)) throw new TypeError('Invalid now timestamp.');
  const blockers = [];
  if (input.evidenceGrade !== 'A') blockers.push('evidence_not_confirmed');
  if (!input.evidenceFresh) blockers.push('stale_evidence');
  if (!input.humanApproved) blockers.push('human_approval_missing');
  if (!input.budgetAvailable) blockers.push('budget_unavailable');
  const policy = input.policyRecord;
  if (!policy || policy.decision !== 'allow') blockers.push('policy_not_allowed');
  else {
    if (policy.action !== input.action) blockers.push('policy_action_mismatch');
    if (typeof policy.version !== 'string' || !policy.version.trim()) blockers.push('policy_version_missing');
    const expiry = Date.parse(policy.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now) blockers.push('policy_expired_or_invalid');
  }
  return { allowed: blockers.length === 0, blockers };
}

/** Contribution scenario, not a revenue forecast. Monetary inputs must share one currency. */
export function contributionScenario({ orders, netPrice, deliveryCostPerOrder, acquisitionCost,
  allocatedBuildCost = 0, otherOverhead = 0, currency = 'EUR' }) {
  if (!Number.isSafeInteger(orders) || orders < 0) throw new RangeError('orders must be a nonnegative safe integer.');
  for (const [key, val] of Object.entries({netPrice, deliveryCostPerOrder, acquisitionCost, allocatedBuildCost, otherOverhead})) {
    nonNegative(val, key);
  }
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new TypeError('Use an ISO-like three-letter currency code.');
  const unit = netPrice - deliveryCostPerOrder;
  const hurdle = acquisitionCost + allocatedBuildCost + otherOverhead;
  return {
    currency,
    unitContribution: round(unit),
    contributionMargin: netPrice > 0 ? unit / netPrice : null,
    totalContribution: round(orders * unit),
    resultBeforeTax: round(orders * unit - hurdle),
    breakEvenOrders: unit > 0 ? Math.ceil(hurdle / unit) : null,
    limitations: 'Assumption scenario; excludes any costs not explicitly entered. No conversion probability implied.'
  };
}
