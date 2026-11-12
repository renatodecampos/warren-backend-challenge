import { describe, expect, it } from 'vitest';
import {
  type FilledOrder,
  type OpenOrder,
  availableCashCents,
  availableShares,
  replay,
} from '../src/accountState';

const ASSET = 7;
const cents = (pesos: number) => Math.round(pesos * 100);

const buy = (size: number, price: number, instrumentId = ASSET): FilledOrder => ({
  instrumentId,
  side: 'BUY',
  size,
  priceCents: cents(price),
});
const sell = (size: number, price: number, instrumentId = ASSET): FilledOrder => ({
  instrumentId,
  side: 'SELL',
  size,
  priceCents: cents(price),
});
const cash = (side: 'CASH_IN' | 'CASH_OUT', pesos: number): FilledOrder => ({
  instrumentId: 66,
  side,
  size: pesos,
  priceCents: 100,
});

const position = (filled: FilledOrder[], open: OpenOrder[] = [], instrumentId = ASSET) =>
  replay(filled, open).positions.get(instrumentId);

describe('replay: average cost', () => {
  it('U1: BUY 10 at 100, BUY 10 at 120, SELL 5 leaves 15 shares at a cost of 1,650.00', () => {
    const afterBuys = position([buy(10, 100), buy(10, 120)]);
    expect(afterBuys).toMatchObject({ quantity: 20, costCents: cents(2200) });

    const afterSale = position([buy(10, 100), buy(10, 120), sell(5, 130)]);
    expect(afterSale).toMatchObject({ quantity: 15, costCents: cents(1650) });
  });

  it('U2: rounds each sale to the cent, half up, and the last sale removes what is left', () => {
    const history = [buy(2, 10), buy(1, 10.01)];
    expect(position(history)).toMatchObject({ quantity: 3, costCents: 3001 });

    history.push(sell(1, 11));
    expect(position(history)).toMatchObject({ quantity: 2, costCents: 2001 }); // removed 10.00

    history.push(sell(1, 11));
    expect(position(history)).toMatchObject({ quantity: 1, costCents: 1000 }); // removed 10.01

    history.push(sell(1, 11));
    expect(position(history)).toMatchObject({ quantity: 0, costCents: 0 }); // removed 10.00
  });

  it('U3: a sale larger than the holding leaves a negative quantity and a cost of zero', () => {
    const oversold = position([buy(20, 1540), sell(30, 1530)]);

    expect(oversold).toMatchObject({ quantity: -10, costCents: 0 });
  });

  it('U3: a BUY from a negative quantity adds cost only for the shares that end above zero', () => {
    const recovered = position([buy(20, 1540), sell(30, 1530), buy(20, 1500)]);
    expect(recovered).toMatchObject({ quantity: 10, costCents: cents(15_000) });

    const stillShort = position([buy(20, 1540), sell(30, 1530), buy(4, 1500)]);
    expect(stillShort).toMatchObject({ quantity: -6, costCents: 0 });

    const backToZero = position([buy(20, 1540), sell(30, 1530), buy(10, 1500)]);
    expect(backToZero).toMatchObject({ quantity: 0, costCents: 0 });
  });

  it('U5: a partial sale is exact where float arithmetic would be off by a cent', () => {
    // Seven purchases, each below the order value cap, build a cost that is not.
    const purchases = [
      ...Array.from({ length: 5 }, () => buy(50_000, 1854.54)),
      buy(43_821, 1854.56),
      buy(1, 1844.69),
    ];
    expect(position(purchases)).toMatchObject({ quantity: 293_822, costCents: 54_490_551_845 });

    const left = position([...purchases, sell(229_795, 400)]);

    // Removed 42,616,469,703 cents. Floats give ...704, one cent of cost that never existed.
    expect(left).toMatchObject({ quantity: 64_027, costCents: 54_490_551_845 - 42_616_469_703 });
  });
});

describe('replay: cash', () => {
  it('moves cash for every FILLED order, including an oversold one', () => {
    const state = replay([cash('CASH_IN', 100_000), buy(20, 1540), sell(30, 1530), cash('CASH_OUT', 1_000)], []);

    expect(state.cashCents).toBe(cents(100_000 - 30_800 + 45_900 - 1_000));
  });

  it('keeps positions of different instruments apart', () => {
    const state = replay([buy(10, 100, 1), buy(5, 20, 2), sell(4, 110, 1)], []);

    expect(state.positions.get(1)).toMatchObject({ quantity: 6, costCents: cents(600) });
    expect(state.positions.get(2)).toMatchObject({ quantity: 5, costCents: cents(100) });
  });
});

describe('replay: reservations of open LIMIT orders', () => {
  it('a NEW BUY reserves cash at its limit price and moves nothing', () => {
    const open: OpenOrder[] = [{ instrumentId: ASSET, side: 'BUY', size: 50, priceCents: cents(710) }];

    const state = replay([cash('CASH_IN', 100_000)], open);

    expect(state.cashCents).toBe(cents(100_000));
    expect(state.reservedCashCents).toBe(cents(35_500));
    expect(availableCashCents(state)).toBe(cents(64_500));
    expect(state.positions.get(ASSET)?.quantity ?? 0).toBe(0);
  });

  it('a NEW SELL reserves its shares and moves nothing', () => {
    const open: OpenOrder[] = [{ instrumentId: ASSET, side: 'SELL', size: 4, priceCents: cents(150) }];

    const state = replay([buy(10, 100)], open);

    expect(state.positions.get(ASSET)).toMatchObject({ quantity: 10, reservedQuantity: 4, costCents: cents(1000) });
    expect(availableShares(state, ASSET)).toBe(6);
    expect(state.reservedCashCents).toBe(0);
  });

  it('an instrument the user never held has no shares available', () => {
    expect(availableShares(replay([], []), 999)).toBe(0);
  });
});

describe('U4: seed data, user 1', () => {
  // The FILLED and NEW orders of user 1 in db/database.sql, in datetime order.
  const filled: FilledOrder[] = [
    cash('CASH_IN', 1_000_000),
    buy(50, 930, 47),
    sell(10, 940, 47),
    cash('CASH_OUT', 100_000),
    buy(20, 1540, 31),
    buy(500, 250, 54),
    sell(30, 1530, 31),
  ];
  const open: OpenOrder[] = [
    { instrumentId: 45, side: 'BUY', size: 50, priceCents: cents(710) },
    { instrumentId: 31, side: 'BUY', size: 60, priceCents: cents(1500) },
  ];

  it('cash 753,000.00, reserved 125,500.00, available 627,500.00', () => {
    const state = replay(filled, open);

    expect(state.cashCents).toBe(cents(753_000));
    expect(state.reservedCashCents).toBe(cents(125_500));
    expect(availableCashCents(state)).toBe(cents(627_500));
  });

  it('holds 40 PAMP and 500 METR; BMA was oversold', () => {
    const { positions } = replay(filled, open);

    expect(positions.get(47)).toMatchObject({ quantity: 40, costCents: cents(37_200) });
    expect(positions.get(54)).toMatchObject({ quantity: 500, costCents: cents(125_000) });
    expect(positions.get(31)).toMatchObject({ quantity: -10, costCents: 0 });
  });
});
