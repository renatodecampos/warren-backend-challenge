import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Portfolio } from '../src/portfolio';
import { api, CASH, createUser, expectError, insertFilled, pool } from './helpers';

afterAll(() => pool.end());

/** Seed instruments. PAMP's latest close is 925.85. */
const PAMP = 47;
/** No row in `marketdata`. */
const UNPRICED = 3;
/** Priced in the seed; this file gives each a later close that only these tests read. */
const ZERO_CLOSE = 12;
const ONE_CENT = 51;

beforeAll(async () => {
  await pool.query(
    `INSERT INTO marketdata (instrumentid, date, close, previousclose) VALUES
       ($1, '2023-07-17', 0, 20.5),
       ($2, '2023-07-17', 0.01, 36)`,
    [ZERO_CLOSE, ONE_CENT],
  );
});

interface StoredOrder {
  id: number;
  status: string;
  size: number;
  price: string | null;
  rejection_reason: string | null;
}

/** The orders this user has, without the deposit `createUser` made. */
async function storedOrders(userId: number): Promise<StoredOrder[]> {
  const found = await pool.query<StoredOrder>(
    `SELECT id, status, size, price, rejection_reason FROM orders
      WHERE userid = $1 AND side IN ('BUY', 'SELL') ORDER BY id`,
    [userId],
  );
  return found.rows;
}

async function portfolio(userId: number): Promise<Portfolio> {
  const res = await api.get(`/users/${userId}/portfolio`);
  expect(res.status).toBe(200);
  return res.body as Portfolio;
}

describe('POST /orders', () => {
  it('O1: a MARKET BUY by size is FILLED at the latest close', async () => {
    const userId = await createUser(100_000);
    const before = Date.now();

    const res = await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 10 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(Number),
      userId,
      instrumentId: PAMP,
      ticker: 'PAMP',
      side: 'BUY',
      type: 'MARKET',
      size: 10,
      price: 925.85,
      status: 'FILLED',
      rejectionReason: null,
      datetime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    // The stored timestamp has no zone; it must come back as the UTC instant it was written at.
    const at = Date.parse(res.body.datetime);
    expect(at).toBeGreaterThanOrEqual(before - 5_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 5_000);

    expect(await storedOrders(userId)).toEqual([
      { id: res.body.id, status: 'FILLED', size: 10, price: '925.85', rejection_reason: null },
    ]);
  });

  it('O1: the fill changes the balance and the position', async () => {
    const userId = await createUser(100_000);

    await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 10 });

    const after = await portfolio(userId);
    expect(after.cashBalance).toBe(90741.5);
    expect(after.availableBalance).toBe(90741.5);
    expect(after.positions).toEqual([
      expect.objectContaining({ instrumentId: PAMP, quantity: 10, averageCost: 925.85, marketValue: 9258.5 }),
    ]);
  });

  it('O1: a MARKET SELL by size is FILLED and returns the cash', async () => {
    const userId = await createUser(100_000);
    await insertFilled(userId, PAMP, 'BUY', 10, 900);

    const res = await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'SELL', type: 'MARKET', size: 4 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ side: 'SELL', size: 4, price: 925.85, status: 'FILLED' });
    const after = await portfolio(userId);
    expect(after.cashBalance).toBe(100_000 - 9_000 + 3_703.4);
    expect(after.positions).toEqual([expect.objectContaining({ instrumentId: PAMP, quantity: 6 })]);
  });

  it('O1: the instrument can be given by ticker, in any case', async () => {
    const userId = await createUser(100_000);

    const res = await api.post('/orders').send({ userId, ticker: 'pamp', side: 'BUY', type: 'MARKET', size: 1 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ instrumentId: PAMP, ticker: 'PAMP', status: 'FILLED' });
  });

  it('O2: a MARKET BUY by amount stores floor(amount / price) shares', async () => {
    const userId = await createUser(100_000);

    const res = await api
      .post('/orders')
      .send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', amount: 5000 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ size: 5, price: 925.85, status: 'FILLED' });
    expect((await portfolio(userId)).cashBalance).toBe(95370.75);
  });

  it('O2: an amount that is an exact multiple of the price buys that many shares', async () => {
    const userId = await createUser(100_000);

    const res = await api
      .post('/orders')
      .send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', amount: 2777.55 });

    expect(res.body).toMatchObject({ size: 3, status: 'FILLED' });
  });

  it('O2: a LIMIT order by amount divides by the limit price', async () => {
    const userId = await createUser(100_000);

    const res = await api
      .post('/orders')
      .send({ userId, instrumentId: PAMP, side: 'BUY', type: 'LIMIT', amount: 1000, price: 300 });

    expect(res.body).toMatchObject({ size: 3, price: 300, status: 'NEW' });
  });

  it('O2: a SELL by amount follows the same rule', async () => {
    const userId = await createUser(0);
    await insertFilled(userId, CASH, 'CASH_IN', 10_000, 1);
    await insertFilled(userId, PAMP, 'BUY', 10, 900);

    const res = await api
      .post('/orders')
      .send({ userId, instrumentId: PAMP, side: 'SELL', type: 'MARKET', amount: 2000 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ side: 'SELL', size: 2, status: 'FILLED' });
  });

  it.each([925.84, 0])('O3: an amount of %d buys less than one share: 422, nothing stored', async (amount) => {
    const userId = await createUser(100_000);

    const res = await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', amount });

    expectError(res, 422, 'AMOUNT_BELOW_ONE_SHARE');
    expect(await storedOrders(userId)).toEqual([]);
  });

  it('O4: a LIMIT order is stored NEW and reduces availableBalance, not cashBalance', async () => {
    const userId = await createUser(100_000);

    const res = await api
      .post('/orders')
      .send({ userId, instrumentId: PAMP, side: 'BUY', type: 'LIMIT', size: 10, price: 900 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'LIMIT', size: 10, price: 900, status: 'NEW', rejectionReason: null });
    const after = await portfolio(userId);
    expect(after.cashBalance).toBe(100_000);
    expect(after.reservedCash).toBe(9_000);
    expect(after.availableBalance).toBe(91_000);
    expect(after.positions).toEqual([]);
  });

  it('O5: a BUY above available cash is stored REJECTED, INSUFFICIENT_FUNDS, 201', async () => {
    const userId = await createUser(1_000);

    const res = await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 10 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      size: 10,
      price: 925.85,
      status: 'REJECTED',
      rejectionReason: 'INSUFFICIENT_FUNDS',
    });
    expect(await storedOrders(userId)).toEqual([
      { id: res.body.id, status: 'REJECTED', size: 10, price: '925.85', rejection_reason: 'INSUFFICIENT_FUNDS' },
    ]);
    expect((await portfolio(userId)).cashBalance).toBe(1_000);
  });

  it('O5: a LIMIT BUY above available cash is REJECTED, not NEW', async () => {
    const userId = await createUser(1_000);

    const res = await api
      .post('/orders')
      .send({ userId, instrumentId: PAMP, side: 'BUY', type: 'LIMIT', size: 2, price: 500.01 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'INSUFFICIENT_FUNDS' });
    expect((await portfolio(userId)).reservedCash).toBe(0);
  });

  it('O5: cash reserved by an open LIMIT BUY is not available to another BUY', async () => {
    const userId = await createUser(10_000);
    await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'BUY', type: 'LIMIT', size: 10, price: 900 });

    const res = await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 2 });

    expect(res.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'INSUFFICIENT_FUNDS' });
  });

  it('O5: a BUY that costs exactly the available cash is FILLED', async () => {
    const userId = await createUser(0);
    await insertFilled(userId, CASH, 'CASH_IN', 1, 9258.5);

    const res = await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 10 });

    expect(res.body).toMatchObject({ status: 'FILLED' });
    expect((await portfolio(userId)).cashBalance).toBe(0);
  });

  it('O6: a SELL above the shares held is REJECTED, INSUFFICIENT_SHARES', async () => {
    const userId = await createUser(100_000);
    await insertFilled(userId, PAMP, 'BUY', 10, 900);

    const none = await api.post('/orders').send({ userId, ticker: 'METR', side: 'SELL', type: 'MARKET', size: 1 });
    const tooMany = await api
      .post('/orders')
      .send({ userId, instrumentId: PAMP, side: 'SELL', type: 'MARKET', size: 11 });

    for (const res of [none, tooMany]) {
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'INSUFFICIENT_SHARES' });
    }
    expect((await portfolio(userId)).positions).toEqual([expect.objectContaining({ quantity: 10 })]);
  });

  it('O6: shares reserved by an open LIMIT SELL cannot be sold again', async () => {
    const userId = await createUser(100_000);
    await insertFilled(userId, PAMP, 'BUY', 10, 900);
    const open = await api
      .post('/orders')
      .send({ userId, instrumentId: PAMP, side: 'SELL', type: 'LIMIT', size: 8, price: 1000 });
    expect(open.body).toMatchObject({ status: 'NEW' });

    const three = await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'SELL', type: 'MARKET', size: 3 });
    const two = await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'SELL', type: 'MARKET', size: 2 });

    expect(three.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'INSUFFICIENT_SHARES' });
    expect(two.body).toMatchObject({ status: 'FILLED' });
  });

  it.each([
    ['no market data', UNPRICED],
    ['a latest close of zero', ZERO_CLOSE],
  ])('O7: %s, by size: stored REJECTED, NO_MARKET_PRICE, with a null price', async (_case, instrumentId) => {
    const userId = await createUser(0);

    const res = await api.post('/orders').send({ userId, instrumentId, side: 'BUY', type: 'MARKET', size: 5 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ size: 5, price: null, status: 'REJECTED', rejectionReason: 'NO_MARKET_PRICE' });
    expect(await storedOrders(userId)).toEqual([
      { id: res.body.id, status: 'REJECTED', size: 5, price: null, rejection_reason: 'NO_MARKET_PRICE' },
    ]);
  });

  it.each([
    ['no market data', UNPRICED],
    ['a latest close of zero', ZERO_CLOSE],
  ])('O7: %s, by amount: 422 NO_PRICE_FOR_AMOUNT, nothing stored', async (_case, instrumentId) => {
    const userId = await createUser(100_000);

    const res = await api.post('/orders').send({ userId, instrumentId, side: 'BUY', type: 'MARKET', amount: 1000 });

    expectError(res, 422, 'NO_PRICE_FOR_AMOUNT');
    expect(await storedOrders(userId)).toEqual([]);
  });

  it('O7: a LIMIT order does not need a market price', async () => {
    const userId = await createUser(100_000);

    const res = await api
      .post('/orders')
      .send({ userId, instrumentId: UNPRICED, side: 'BUY', type: 'LIMIT', size: 5, price: 10 });

    expect(res.body).toMatchObject({ price: 10, status: 'NEW' });
  });

  it.each([
    ['one cent above the cap', { type: 'LIMIT', size: 1, price: 100_000_000 }],
    ['an absurd product', { type: 'LIMIT', size: 2_147_483_647, price: 99_999_999.99 }],
    ['a MARKET order whose size x close passes the cap', { type: 'MARKET', size: 20_000_000 }],
    ['an amount above the cap', { type: 'MARKET', amount: 100_000_925.85 }],
  ])('O8: %s is 422 ORDER_VALUE_TOO_LARGE, nothing stored', async (_case, order) => {
    const userId = await createUser(2_000_000_000);

    const res = await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'BUY', ...order });

    expectError(res, 422, 'ORDER_VALUE_TOO_LARGE');
    expect(await storedOrders(userId)).toEqual([]);
  });

  it('O8: an amount that buys more shares than an order can hold is 422, nothing stored', async () => {
    const userId = await createUser(2_000_000_000);

    const res = await api
      .post('/orders')
      .send({ userId, instrumentId: ONE_CENT, side: 'BUY', type: 'MARKET', amount: 30_000_000 });

    expectError(res, 422, 'ORDER_VALUE_TOO_LARGE');
    expect(await storedOrders(userId)).toEqual([]);
  });

  it('O8: exactly at the cap is accepted', async () => {
    const userId = await createUser(2_000_000_000);

    const res = await api
      .post('/orders')
      .send({ userId, instrumentId: PAMP, side: 'BUY', type: 'LIMIT', size: 1, price: 99_999_999.99 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ price: 99_999_999.99, status: 'NEW' });
    expect((await portfolio(userId)).reservedCash).toBe(99_999_999.99);
  });

  describe('O9: validation', () => {
    let userId: number;
    beforeAll(async () => {
      userId = await createUser(100_000);
    });

    const market = { instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 1 };
    const limit = { ...market, type: 'LIMIT', price: 900 };

    it.each<[string, Record<string, unknown>]>([
      ['LIMIT without price', { ...limit, price: undefined }],
      ['MARKET with price', { ...market, price: 900 }],
      ['both size and amount', { ...market, amount: 1000 }],
      ['neither size nor amount', { ...market, size: undefined }],
      ['amount with three decimals', { ...market, size: undefined, amount: 1000.005 }],
      ['price with three decimals', { ...limit, price: 900.005 }],
      ['an unknown field', { ...market, note: 'hello' }],
      ['both instrumentId and ticker', { ...market, ticker: 'PAMP' }],
      ['neither instrumentId nor ticker', { ...market, instrumentId: undefined }],
      ['an empty ticker', { ...market, instrumentId: undefined, ticker: '' }],
      ['a ticker of 11 characters', { ...market, instrumentId: undefined, ticker: 'ABCDEFGHIJK' }],
      ['a size of zero', { ...market, size: 0 }],
      ['a negative size', { ...market, size: -1 }],
      ['a fractional size', { ...market, size: 1.5 }],
      ['a size above 32 bits', { ...market, size: 2_147_483_648 }],
      ['a size written as a string', { ...market, size: '1' }],
      ['a negative amount', { ...market, size: undefined, amount: -10 }],
      ['a price of zero', { ...limit, price: 0 }],
      ['a negative price', { ...limit, price: -900 }],
      ['an unknown side', { ...market, side: 'CASH_IN' }],
      ['an unknown type', { ...market, type: 'STOP' }],
      ['an instrumentId that is not an id', { ...market, instrumentId: 0 }],
    ])('%s is 400 VALIDATION_ERROR', async (_case, order) => {
      expectError(await api.post('/orders').send({ userId, ...order }), 400, 'VALIDATION_ERROR');
    });

    it.each([undefined, 0, '1', 2_147_483_648])('a userId of %s is 400 VALIDATION_ERROR', async (bad) => {
      expectError(await api.post('/orders').send({ ...market, userId: bad }), 400, 'VALIDATION_ERROR');
    });

    it('a request without a body is 400 VALIDATION_ERROR', async () => {
      expectError(await api.post('/orders'), 400, 'VALIDATION_ERROR');
    });

    it('none of them stored an order', async () => {
      expect(await storedOrders(userId)).toEqual([]);
    });
  });

  it('O10: an unknown user is 404 USER_NOT_FOUND', async () => {
    const res = await api
      .post('/orders')
      .send({ userId: 999_999, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 1 });

    expectError(res, 404, 'USER_NOT_FOUND');
  });

  it.each([{ instrumentId: 999_999 }, { ticker: 'NOPE' }])(
    'O10: the unknown instrument %o is 404 INSTRUMENT_NOT_FOUND',
    async (instrument) => {
      const userId = await createUser(100_000);

      const res = await api.post('/orders').send({ userId, ...instrument, side: 'BUY', type: 'MARKET', size: 1 });

      expectError(res, 404, 'INSTRUMENT_NOT_FOUND');
      expect(await storedOrders(userId)).toEqual([]);
    },
  );

  it.each([{ instrumentId: CASH }, { ticker: 'ARS' }])(
    'O10: the cash instrument %o is 400 INVALID_INSTRUMENT',
    async (instrument) => {
      const userId = await createUser(100_000);

      const res = await api.post('/orders').send({ userId, ...instrument, side: 'BUY', type: 'MARKET', size: 1 });

      expectError(res, 400, 'INVALID_INSTRUMENT');
      const stored = await pool.query('SELECT 1 FROM orders WHERE userid = $1', [userId]);
      expect(stored.rowCount).toBe(1);
    },
  );

  it('O11: 10 simultaneous orders against a balance that fits 3 give 3 FILLED and 7 REJECTED', async () => {
    // 10 PAMP at 925.85 cost 9,258.50: 30,000 pays for three of them and not for a fourth.
    const userId = await createUser(30_000);
    const order = { userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 10 };

    const responses = await Promise.all(Array.from({ length: 10 }, () => api.post('/orders').send(order)));

    expect(responses.map((res) => res.status)).toEqual(Array<number>(10).fill(201));
    const stored = await storedOrders(userId);
    expect(stored.filter((o) => o.status === 'FILLED')).toHaveLength(3);
    expect(stored.filter((o) => o.status === 'REJECTED')).toHaveLength(7);
    expect(stored.filter((o) => o.status === 'REJECTED').map((o) => o.rejection_reason)).toEqual(
      Array<string>(7).fill('INSUFFICIENT_FUNDS'),
    );
    expect((await portfolio(userId)).cashBalance).toBe(2224.5);
  });
});
