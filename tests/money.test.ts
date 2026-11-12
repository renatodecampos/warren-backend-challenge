import { describe, expect, it } from 'vitest';
import {
  MAX_ORDER_VALUE_CENTS,
  exceedsOrderValueCap,
  fromCents,
  hasAtMostTwoDecimals,
  multiplyExact,
  proportionRounded,
  toCents,
} from '../src/money';

describe('U7: two-decimal check and cents conversion', () => {
  it('accepts amounts with up to two decimals', () => {
    for (const value of [1, 930, 450.5, 0.01, 925.85, 99999999.99]) {
      expect(hasAtMostTwoDecimals(value), String(value)).toBe(true);
    }
  });

  it('refuses a third decimal, a float artefact and anything that is not a plain amount', () => {
    for (const value of [1.005, 0.001, 0.1 + 0.2, 1e-7, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hasAtMostTwoDecimals(value), String(value)).toBe(false);
    }
  });

  it('converts pesos to integer cents without float drift', () => {
    expect(toCents(0.1)).toBe(10);
    expect(toCents(1.15)).toBe(115); // 1.15 * 100 is 114.99999999999999
    expect(toCents(925.85)).toBe(92585);
    expect(toCents(99999999.99)).toBe(9_999_999_999);
  });

  it('adds exactly in cents where floats do not', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toCents(0.1) + toCents(0.2)).toBe(toCents(0.3));
  });

  it('converts cents back to pesos', () => {
    expect(fromCents(92585)).toBe(925.85);
    expect(fromCents(9_999_999_999)).toBe(99999999.99);
    expect(fromCents(-1650)).toBe(-16.5);
  });
});

describe('U6: order value cap', () => {
  it('accepts an order exactly at the cap', () => {
    expect(MAX_ORDER_VALUE_CENTS).toBe(9_999_999_999);
    expect(exceedsOrderValueCap(1, 9_999_999_999)).toBe(false);
    expect(exceedsOrderValueCap(3, 3_333_333_333)).toBe(false);
  });

  it('refuses one cent above the cap', () => {
    expect(exceedsOrderValueCap(1, 10_000_000_000)).toBe(true);
    expect(exceedsOrderValueCap(2, 5_000_000_000)).toBe(true);
  });

  it('refuses an absurd product that floats cannot represent exactly', () => {
    const size = 2_147_483_647;
    const priceCents = 9_999_999_999;

    expect(Number.isSafeInteger(size * priceCents)).toBe(false);
    expect(exceedsOrderValueCap(size, priceCents)).toBe(true);
  });
});

describe('U5: products the cap does not bound', () => {
  it('multiplies exactly and returns a number', () => {
    expect(multiplyExact(500, 22950)).toBe(11_475_000);
    expect(multiplyExact(94_906_265, 94_906_265)).toBe(9_007_199_136_250_225);
  });

  it('fails loudly instead of returning an inexact product', () => {
    expect(() => multiplyExact(2_147_483_647, 9_999_999_999)).toThrow(RangeError);
  });

  it('takes a proportion of an amount, half a cent rounding up', () => {
    expect(proportionRounded(220_000, 5, 20)).toBe(55_000);
    expect(proportionRounded(3001, 1, 3)).toBe(1000); // 1000.33
    expect(proportionRounded(2001, 1, 2)).toBe(1001); // 1000.5
  });

  it('takes a proportion exactly where float arithmetic is off by a cent', () => {
    // A position of 293,822 shares that cost 544,905,518.45, built from several orders below the cap.
    const costCents = 54_490_551_845;
    const quantity = 293_822;
    const sold = 229_795;

    expect(Number.isSafeInteger(costCents * sold)).toBe(false);
    expect(Math.round((costCents * sold) / quantity)).toBe(42_616_469_704); // what floats give
    expect(proportionRounded(costCents, sold, quantity)).toBe(42_616_469_703);
  });
});
