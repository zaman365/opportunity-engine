/** Integer micro-units; transports are canonical decimal strings. */
export function micro(value) {
  if(typeof value!=='string'||! /^(0|[1-9][0-9]{0,14})$/.test(value))
    throw new TypeError('Cost must be a canonical nonnegative decimal string, at most 15 digits.');
  return BigInt(value);
}
export function currency(value) {
  if(typeof value!=='string'||! /^[A-Z]{3}$/.test(value)) throw new TypeError('Three-letter uppercase currency required.');
  return value;
}
export function remaining({limit,settled,reserved}) {
  const balance=micro(limit)-micro(settled)-micro(reserved);
  return {amount:balance.toString(),overrun:balance<0n};
}
