/**
 * The build kit's reference modules are plain, untyped `.mjs` and must stay byte-identical,
 * so they cannot carry type annotations. These declarations exist only so the parity tests
 * can import them; the typed implementations live in `packages/domain`.
 */
declare module '*/opportunity-engine-build-kit/reference/scoring.mjs' {
  export function scoreOpportunity(dimensions: unknown): any;
  export function aggregateNeed(findings: unknown): any;
  export function checkActionReadiness(input: unknown): any;
  export function contributionScenario(input: unknown): any;
  export const WEIGHTS: Record<string, number>;
}
declare module '*/opportunity-engine-build-kit/reference/money.mjs' {
  export function micro(value: string): bigint;
  export function currency(value: string): string;
  export function remaining(input: unknown): any;
}
declare module '*/opportunity-engine-build-kit/reference/detector-link.mjs' {
  export function evaluateImportantLink(input: unknown): any;
}
declare module '*/opportunity-engine-build-kit/reference/url-policy.mjs' {
  export function preflightTarget(raw: string, allowedHosts?: readonly string[]): any;
}
declare module '*/opportunity-engine-build-kit/reference/state-machine.mjs' {
  export const MACHINES: Record<string, Record<string, string[]>>;
  export function transition(input: unknown): any;
}
declare module '*/opportunity-engine-build-kit/reference/budget-ledger.mjs' {
  export function reserve(ledger: unknown, input: unknown): any;
  export function settle(ledger: unknown, input: unknown): any;
  export function release(ledger: unknown, input: unknown): any;
  export function markUncertain(ledger: unknown, key: string): any;
}
