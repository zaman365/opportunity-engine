/**
 * Integer micro-units. 1 unit = 0.000001 of the currency unit.
 *
 * Transports and storage use canonical decimal strings / bigint. There is no float path:
 * `docs/architecture/BUDGET_LEDGER.md` forbids arithmetic on floating point amounts.
 * Ported from `reference/money.mjs`; `test/reference-parity.test.ts` pins the behaviour.
 */

const CANONICAL_MICRO = /^(0|[1-9][0-9]{0,14})$/;
const CURRENCY = /^[A-Z]{3}$/;

export class MoneyError extends TypeError {}

export function micro(value: string): bigint {
  if (typeof value !== 'string' || !CANONICAL_MICRO.test(value)) {
    throw new MoneyError('Cost must be a canonical nonnegative decimal string, at most 15 digits.');
  }
  return BigInt(value);
}

export function currency(value: string): string {
  if (typeof value !== 'string' || !CURRENCY.test(value)) {
    throw new MoneyError('Three-letter uppercase currency required.');
  }
  return value;
}

/** Canonical string for a nonnegative bigint amount. Negative totals are a ledger bug. */
export function toMicroString(value: bigint): string {
  if (value < 0n) throw new MoneyError('Micro amounts are nonnegative.');
  if (value > 999_999_999_999_999n) throw new MoneyError('Micro amount exceeds 15 digits.');
  return value.toString();
}

export interface RemainingInput {
  limit: string;
  settled: string;
  reserved: string;
}

export function remaining({ limit, settled, reserved }: RemainingInput): {
  amount: string;
  overrun: boolean;
} {
  const balance = micro(limit) - micro(settled) - micro(reserved);
  return { amount: balance.toString(), overrun: balance < 0n };
}

/**
 * Display helper for the operator UI. Provider micro-costs need more precision than
 * two decimals, so the caller states how many fraction digits carry meaning.
 */
export function formatMicro(amountMicro: string, fractionDigits = 6): string {
  const value = micro(amountMicro);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0');
  if (fractionDigits <= 0) return whole.toString();
  return `${whole}.${fraction.slice(0, Math.min(6, fractionDigits))}`;
}
