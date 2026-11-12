import { afterAll, describe, expect, it } from 'vitest';
import type { Portfolio } from '../src/portfolio';
import { api, CASH, createUser, expectError, pool } from './helpers';

afterAll(() => pool.end());

/** Seed instrument. PAMP's latest close is 925.85. */
const PAMP = 47;

const KEY = 'Idempotency-Key';

async function portfolio(userId: number): Promise<Portfolio> {
  const res = await api.get(`/users/${userId}/portfolio`);
  expect(res.status).toBe(200);
  return res.body as Portfolio;
}

/** The transfers this user has stored, without the deposit `createUser` made. */
async function storedTransfers(userId: number): Promise<{ side: string; size: number; status: string }[]> {
  const found = await pool.query<{ side: string; size: number; status: string }>(
    `SELECT side, size, status FROM orders
      WHERE userid = $1 AND side IN ('CASH_IN', 'CASH_OUT') AND datetime > TIMESTAMP '2024-01-01'
      ORDER BY id`,
    [userId],
  );
  return found.rows;
}

describe('POST /transfers', () => {
  it('T1: a CASH_IN is a FILLED order on the cash instrument and raises the balance by amount', async () => {
    const userId = await createUser(1_000);

    const res = await api.post('/transfers').send({ userId, side: 'CASH_IN', amount: 2_500 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(Number),
      userId,
      instrumentId: CASH,
      ticker: 'ARS',
      side: 'CASH_IN',
      type: 'MARKET',
      size: 2_500,
      price: 1,
      status: 'FILLED',
      rejectionReason: null,
      datetime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    expect(await portfolio(userId)).toMatchObject({ cashBalance: 3_500, availableBalance: 3_500 });
  });

  it('T1: a CASH_OUT lowers the balance by amount', async () => {
    const userId = await createUser(1_000);

    const res = await api.post('/transfers').send({ userId, side: 'CASH_OUT', amount: 400 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ side: 'CASH_OUT', size: 400, price: 1, status: 'FILLED' });
    expect(await portfolio(userId)).toMatchObject({ cashBalance: 600, availableBalance: 600 });
  });

  it('T1: a CASH_OUT of exactly the available cash is FILLED', async () => {
    const userId = await createUser(1_000);

    const res = await api.post('/transfers').send({ userId, side: 'CASH_OUT', amount: 1_000 });

    expect(res.body).toMatchObject({ status: 'FILLED' });
    expect((await portfolio(userId)).cashBalance).toBe(0);
  });

  it('T1: the largest amount is accepted', async () => {
    const userId = await createUser(0);

    const res = await api.post('/transfers').send({ userId, side: 'CASH_IN', amount: 99_999_999 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ size: 99_999_999, status: 'FILLED' });
  });

  it('T1: a repeated CASH_IN with the same Idempotency-Key deposits once', async () => {
    const userId = await createUser(1_000);
    const transfer = { userId, side: 'CASH_IN', amount: 500 };

    const first = await api.post('/transfers').set(KEY, 'deposit-1').send(transfer);
    const second = await api.post('/transfers').set(KEY, 'deposit-1').send(transfer);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect((await portfolio(userId)).cashBalance).toBe(1_500);
    expect(await storedTransfers(userId)).toHaveLength(1);
  });

  it('T1: the same key with another amount is 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const userId = await createUser(1_000);
    await api.post('/transfers').set(KEY, 'deposit-2').send({ userId, side: 'CASH_IN', amount: 500 });

    const res = await api.post('/transfers').set(KEY, 'deposit-2').send({ userId, side: 'CASH_IN', amount: 501 });

    expectError(res, 422, 'IDEMPOTENCY_KEY_REUSED');
    expect(await storedTransfers(userId)).toHaveLength(1);
  });

  it('T1: an invalid Idempotency-Key is 400, nothing stored', async () => {
    const userId = await createUser(1_000);

    const res = await api
      .post('/transfers')
      .set(KEY, 'k'.repeat(51))
      .send({ userId, side: 'CASH_IN', amount: 500 });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(await storedTransfers(userId)).toEqual([]);
  });

  it('T1: an unknown user is 404 USER_NOT_FOUND', async () => {
    const res = await api.post('/transfers').send({ userId: 2_147_483_647, side: 'CASH_IN', amount: 500 });

    expectError(res, 404, 'USER_NOT_FOUND');
  });

  it.each([
    ['an amount of zero', { side: 'CASH_IN', amount: 0 }],
    ['an amount with cents', { side: 'CASH_IN', amount: 10.5 }],
    ['an amount above 99,999,999', { side: 'CASH_IN', amount: 100_000_000 }],
    ['an amount that is not a number', { side: 'CASH_IN', amount: '100' }],
    ['no amount', { side: 'CASH_IN' }],
    ['a side that is not a transfer', { side: 'BUY', amount: 100 }],
    ['no side', { amount: 100 }],
    ['an unknown field', { side: 'CASH_IN', amount: 100, instrumentId: 47 }],
  ])('T1: %s is 400 VALIDATION_ERROR, nothing stored', async (_name, fields) => {
    const userId = await createUser(1_000);

    const res = await api.post('/transfers').send({ userId, ...fields });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(await storedTransfers(userId)).toEqual([]);
  });

  it('T2: a CASH_OUT above the cash is stored REJECTED, INSUFFICIENT_FUNDS, 201', async () => {
    const userId = await createUser(1_000);

    const res = await api.post('/transfers').send({ userId, side: 'CASH_OUT', amount: 1_001 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      side: 'CASH_OUT',
      size: 1_001,
      price: 1,
      status: 'REJECTED',
      rejectionReason: 'INSUFFICIENT_FUNDS',
    });
    expect(await storedTransfers(userId)).toEqual([{ side: 'CASH_OUT', size: 1_001, status: 'REJECTED' }]);
    expect((await portfolio(userId)).cashBalance).toBe(1_000);
  });

  it('T2: cash reserved by an open LIMIT BUY cannot be withdrawn', async () => {
    const userId = await createUser(10_000);
    await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'BUY', type: 'LIMIT', size: 10, price: 900 });

    const res = await api.post('/transfers').send({ userId, side: 'CASH_OUT', amount: 1_001 });

    expect(res.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'INSUFFICIENT_FUNDS' });
    expect(await portfolio(userId)).toMatchObject({ cashBalance: 10_000, availableBalance: 1_000 });
  });

  it('T2: a rejected CASH_OUT replays as the same rejection with the same key', async () => {
    const userId = await createUser(1_000);
    const transfer = { userId, side: 'CASH_OUT', amount: 1_001 };

    const first = await api.post('/transfers').set(KEY, 'rejected-1').send(transfer);
    const second = await api.post('/transfers').set(KEY, 'rejected-1').send(transfer);

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'INSUFFICIENT_FUNDS' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await storedTransfers(userId)).toHaveLength(1);
  });

  it('T2: two simultaneous withdrawals that fit once give one FILLED and one REJECTED', async () => {
    const userId = await createUser(1_000);
    const transfer = { userId, side: 'CASH_OUT', amount: 1_000 };

    const responses = await Promise.all([api.post('/transfers').send(transfer), api.post('/transfers').send(transfer)]);

    expect(responses.map((res) => res.status)).toEqual([201, 201]);
    expect(responses.map((res) => (res.body as { status: string }).status).sort()).toEqual(['FILLED', 'REJECTED']);
    expect((await portfolio(userId)).cashBalance).toBe(0);
    expect(await storedTransfers(userId)).toHaveLength(2);
  });

  it('T1: the idempotency namespace is shared with POST /orders', async () => {
    const userId = await createUser(10_000);
    await api
      .post('/orders')
      .set(KEY, 'shared-1')
      .send({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 1 });

    const res = await api.post('/transfers').set(KEY, 'shared-1').send({ userId, side: 'CASH_IN', amount: 100 });

    expectError(res, 422, 'IDEMPOTENCY_KEY_REUSED');
    expect(await storedTransfers(userId)).toEqual([]);
  });
});
