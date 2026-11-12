import { afterAll, describe, expect, it } from 'vitest';
import { api, CASH, createUser, expectError, insertFilled, pool } from './helpers';

afterAll(() => pool.end());

/** Seed instruments. PAMP's latest close is 925.85. */
const PAMP = 47;
/** Latest close 9,163.00 in the seed; I7 gives it a later one, and only this file reads it. */
const REPRICED = 5;

const KEY = 'Idempotency-Key';

interface StoredOrder {
  id: number;
  status: string;
  size: number;
  idempotency_key: string | null;
  request_hash: string | null;
}

/** The orders this user has, without the deposit `createUser` made. */
async function storedOrders(userId: number): Promise<StoredOrder[]> {
  const found = await pool.query<StoredOrder>(
    `SELECT id, status, size, idempotency_key, request_hash FROM orders
      WHERE userid = $1 AND side IN ('BUY', 'SELL') ORDER BY id`,
    [userId],
  );
  return found.rows;
}

describe('Idempotency-Key on POST /orders', () => {
  it('I1: same key, same body: 200 with the same order, one row', async () => {
    const userId = await createUser(100_000);
    const order = { userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 10 };

    const first = await api.post('/orders').set(KEY, 'retry-1').send(order);
    const second = await api.post('/orders').set(KEY, 'retry-1').send(order);

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'FILLED', size: 10, price: 925.85 });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await storedOrders(userId)).toEqual([
      {
        id: first.body.id,
        status: 'FILLED',
        size: 10,
        idempotency_key: 'retry-1',
        request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  it('I1: the same body with its fields in another order is the same request', async () => {
    const userId = await createUser(100_000);

    const first = await api
      .post('/orders')
      .set(KEY, 'reordered')
      .send({ userId, instrumentId: PAMP, side: 'BUY', type: 'LIMIT', size: 10, price: 900 });
    const second = await api
      .post('/orders')
      .set(KEY, 'reordered')
      .send({ price: 900.0, size: 10, type: 'LIMIT', side: 'BUY', instrumentId: PAMP, userId });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await storedOrders(userId)).toHaveLength(1);
  });

  it('I1: an order sent without a key stores no key and no hash', async () => {
    const userId = await createUser(100_000);

    await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 1 });

    expect(await storedOrders(userId)).toEqual([
      expect.objectContaining({ idempotency_key: null, request_hash: null }),
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['another size', { instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 11 }],
    ['another side', { instrumentId: PAMP, side: 'SELL', type: 'MARKET', size: 10 }],
    ['amount in place of size', { instrumentId: PAMP, side: 'BUY', type: 'MARKET', amount: 10 }],
    ['ticker in place of instrumentId', { ticker: 'PAMP', side: 'BUY', type: 'MARKET', size: 10 }],
  ])('I2: same key with %s: 422 IDEMPOTENCY_KEY_REUSED, one row', async (_case, different) => {
    const userId = await createUser(100_000);
    const first = await api
      .post('/orders')
      .set(KEY, 'reused')
      .send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 10 });
    expect(first.status).toBe(201);

    const second = await api.post('/orders').set(KEY, 'reused').send({ userId, ...different });

    expectError(second, 422, 'IDEMPOTENCY_KEY_REUSED');
    expect(await storedOrders(userId)).toEqual([expect.objectContaining({ id: first.body.id, size: 10 })]);
  });

  it('I3: a rejected order replays as the same rejection, even after a deposit', async () => {
    const userId = await createUser(1_000);
    const order = { userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 10 };
    const first = await api.post('/orders').set(KEY, 'rejected').send(order);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'INSUFFICIENT_FUNDS' });

    await insertFilled(userId, CASH, 'CASH_IN', 100_000, 1);
    const second = await api.post('/orders').set(KEY, 'rejected').send(order);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await storedOrders(userId)).toEqual([expect.objectContaining({ id: first.body.id, status: 'REJECTED' })]);
  });

  it('I4: a request refused with 4xx stored no key: the fixed request with the same key succeeds', async () => {
    const userId = await createUser(100_000);
    const order = { userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET' };

    const invalid = await api.post('/orders').set(KEY, 'fixed').send(order);
    const unknown = await api.post('/orders').set(KEY, 'fixed').send({ ...order, instrumentId: 999_999, size: 1 });
    const tooSmall = await api.post('/orders').set(KEY, 'fixed').send({ ...order, amount: 100 });
    expectError(invalid, 400, 'VALIDATION_ERROR');
    expectError(unknown, 404, 'INSTRUMENT_NOT_FOUND');
    expectError(tooSmall, 422, 'AMOUNT_BELOW_ONE_SHARE');
    expect(await storedOrders(userId)).toEqual([]);

    const fixed = await api.post('/orders').set(KEY, 'fixed').send({ ...order, amount: 1000 });

    expect(fixed.status).toBe(201);
    expect(fixed.body).toMatchObject({ status: 'FILLED', size: 1 });
    expect(await storedOrders(userId)).toEqual([expect.objectContaining({ idempotency_key: 'fixed' })]);
  });

  it('I5: the same key from two users gives two orders', async () => {
    const one = await createUser(100_000);
    const other = await createUser(100_000);
    const order = { instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 1 };

    const first = await api.post('/orders').set(KEY, 'shared').send({ userId: one, ...order });
    const second = await api.post('/orders').set(KEY, 'shared').send({ userId: other, ...order });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(await storedOrders(one)).toHaveLength(1);
    expect(await storedOrders(other)).toHaveLength(1);
  });

  it('I6: two simultaneous requests with the same key give one row', async () => {
    const userId = await createUser(100_000);
    const order = { userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 10 };

    const [a, b] = await Promise.all([
      api.post('/orders').set(KEY, 'simultaneous').send(order),
      api.post('/orders').set(KEY, 'simultaneous').send(order),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body).toEqual(b.body);
    expect(await storedOrders(userId)).toEqual([expect.objectContaining({ id: a.body.id, status: 'FILLED' })]);
  });

  it('I7: an amount order replayed after the price changed returns the original order', async () => {
    const userId = await createUser(100_000);
    const order = { userId, instrumentId: REPRICED, side: 'BUY', type: 'MARKET', amount: 20_000 };
    const first = await api.post('/orders').set(KEY, 'repriced').send(order);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ size: 2, price: 9163, status: 'FILLED' });

    await pool.query(
      `INSERT INTO marketdata (instrumentid, date, close, previousclose) VALUES ($1, '2023-07-18', 5000, 9163)`,
      [REPRICED],
    );
    const second = await api.post('/orders').set(KEY, 'repriced').send(order);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await storedOrders(userId)).toEqual([expect.objectContaining({ id: first.body.id, size: 2 })]);
  });

  it.each([
    ['empty', ''],
    ['of 51 characters', 'k'.repeat(51)],
    ['with a character outside ASCII', 'clé'],
    ['with a tab inside', 'a\tb'],
  ])('I8: a key %s is 400 VALIDATION_ERROR, nothing stored', async (_case, key) => {
    const userId = await createUser(100_000);

    const res = await api
      .post('/orders')
      .set(KEY, key)
      .send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 1 });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(await storedOrders(userId)).toEqual([]);
  });

  it('I8: a key of 50 printable characters, spaces included, is accepted', async () => {
    const userId = await createUser(100_000);
    const key = `order 2026-11-12 #1 ~${'k'.repeat(29)}`;
    expect(key).toHaveLength(50);

    const res = await api
      .post('/orders')
      .set(KEY, key)
      .send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 1 });

    expect(res.status).toBe(201);
    expect(await storedOrders(userId)).toEqual([expect.objectContaining({ idempotency_key: key })]);
  });
});
