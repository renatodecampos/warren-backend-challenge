/**
 * Money is integer cents everywhere in the code (ADR 0006). Floats exist only at the edge:
 * `toCents` on the way in, `fromCents` on the way out.
 */

/** The value of one order, `size x price`, may not exceed 99,999,999.99 pesos. */
export const MAX_ORDER_VALUE_CENTS = 9_999_999_999;

const PLAIN_AMOUNT = /^\d+(\.\d{1,2})?$/;

/**
 * True for a non-negative amount with at most two decimals. The check reads the shortest decimal
 * form of the number, which is what the client wrote in the JSON, so it does not depend on
 * multiplying a float.
 */
export function hasAtMostTwoDecimals(value: number): boolean {
  return Number.isFinite(value) && PLAIN_AMOUNT.test(String(value));
}

/** Pesos to cents. Call only after `hasAtMostTwoDecimals`; the rounding removes the float artefact. */
export function toCents(pesos: number): number {
  return Math.round(pesos * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * Checked before any other use of the product. Far above the cap the multiplication is inexact,
 * but such a value is still above the cap, so the comparison is right.
 */
export function exceedsOrderValueCap(size: number, priceCents: number): boolean {
  return size * priceCents > MAX_ORDER_VALUE_CENTS;
}

function toSafeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`Amount ${value} is outside the exact integer range`);
  }
  return result;
}

/**
 * `a x b` computed in BigInt. Used for the products the order value cap does not bound, such as
 * `quantity x close`. Fails loudly instead of returning an inexact number.
 */
export function multiplyExact(a: number, b: number): number {
  return toSafeNumber(BigInt(a) * BigInt(b));
}

/**
 * `amount x part / whole`, rounded to the nearest integer with half rounding up. The product is
 * computed in BigInt: `cost x sold` can pass the safe-integer limit with every input valid.
 * All three arguments are non-negative integers and `whole` is positive.
 */
export function proportionRounded(amount: number, part: number, whole: number): number {
  const divisor = BigInt(whole);
  return toSafeNumber((2n * BigInt(amount) * BigInt(part) + divisor) / (2n * divisor));
}
