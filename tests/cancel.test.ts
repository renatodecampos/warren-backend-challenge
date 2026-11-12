import { afterAll, describe, expect, it } from 'vitest';
import type { Portfolio } from '../src/portfolio';
import { api, createUser, expectError, insertFilled, pool } from './helpers';

afterAll(() => pool.end());

/** Seed instrument. PAMP's latest close is 925.85. */
const PAMP = 47;

interface PlacedOrder {
  id: number;
  status: string;
}

async function place(body: Record<string, unknown>): Promise<PlacedOrder> {
  const res = await api.post('/orders').send(body);
  expect(res.status).toBe(201);
  return res.body as PlacedOrder;
}

/** An open LIMIT BUY that reserves 9,000.00. */
async function placeOpen(userId: number): Promise<PlacedOrder> {
  const order = await place({ userId, instrumentId: PAMP, side: 'BUY', type: 'LIMIT', size: 10, price: 900 });
  expect(order.status).toBe('NEW');
  return order;
}

async function portfolio(userId: number): Promise<Portfolio> {
  const res = await api.get(`/users/${userId}/portfolio`);
  expect(res.status).toBe(200);
  return res.body as Portfolio;
}

async function storedStatus(orderId: number): Promise<string | undefined> {
  const found = await pool.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
  return found.rows[0]?.status;
}

describe('POST /orders/:orderId/cancel', () => {
  it('C1: cancelling a NEW order is 200 with the order CANCELLED', async () => {
    const userId = await createUser(100_000);
    const order = await placeOpen(userId);

    const res = await api.post(`/orders/${order.id}/cancel`).send({ userId });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...order, status: 'CANCELLED' });
    expect(await storedStatus(order.id)).toBe('CANCELLED');
  });

  it('C1: cancelling releases the reserved cash', async () => {
    const userId = await createUser(100_000);
    const order = await placeOpen(userId);
    expect(await portfolio(userId)).toMatchObject({ reservedCash: 9_000, availableBalance: 91_000 });

    await api.post(`/orders/${order.id}/cancel`).send({ userId });

    expect(await portfolio(userId)).toMatchObject({
      cashBalance: 100_000,
      reservedCash: 0,
      availableBalance: 100_000,
    });
  });

  it('C1: cancelling a NEW SELL releases the reserved shares', async () => {
    const userId = await createUser(100_000);
    await insertFilled(userId, PAMP, 'BUY', 10, 900);
    const open = await api
      .post('/orders')
      .send({ userId, instrumentId: PAMP, side: 'SELL', type: 'LIMIT', size: 4, price: 1_000 });
    expect(open.body).toMatchObject({ status: 'NEW' });

    // 4 of the 10 shares are reserved: 7 is above what is available.
    const before = await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'SELL', type: 'MARKET', size: 7 });
    expect(before.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'INSUFFICIENT_SHARES' });

    await api.post(`/orders/${open.body.id}/cancel`).send({ userId });

    const after = await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'SELL', type: 'MARKET', size: 7 });
    expect(after.body).toMatchObject({ status: 'FILLED' });
  });

  it('C2: cancelling a FILLED order is 409 ORDER_NOT_CANCELLABLE', async () => {
    const userId = await createUser(100_000);
    const order = await place({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 1 });
    expect(order.status).toBe('FILLED');

    const res = await api.post(`/orders/${order.id}/cancel`).send({ userId });

    expectError(res, 409, 'ORDER_NOT_CANCELLABLE');
    expect(await storedStatus(order.id)).toBe('FILLED');
  });

  it('C2: cancelling a REJECTED order is 409 ORDER_NOT_CANCELLABLE', async () => {
    const userId = await createUser(100);
    const order = await place({ userId, instrumentId: PAMP, side: 'BUY', type: 'MARKET', size: 1 });
    expect(order.status).toBe('REJECTED');

    const res = await api.post(`/orders/${order.id}/cancel`).send({ userId });

    expectError(res, 409, 'ORDER_NOT_CANCELLABLE');
    expect(await storedStatus(order.id)).toBe('REJECTED');
  });

  it('C2: cancelling a CANCELLED order is 409 ORDER_NOT_CANCELLABLE', async () => {
    const userId = await createUser(100_000);
    const order = await placeOpen(userId);
    await api.post(`/orders/${order.id}/cancel`).send({ userId });

    const res = await api.post(`/orders/${order.id}/cancel`).send({ userId });

    expectError(res, 409, 'ORDER_NOT_CANCELLABLE');
  });

  it("C2: another user's order is 404 ORDER_NOT_FOUND and stays NEW", async () => {
    const owner = await createUser(100_000);
    const other = await createUser(100_000);
    const order = await placeOpen(owner);

    const res = await api.post(`/orders/${order.id}/cancel`).send({ userId: other });

    expectError(res, 404, 'ORDER_NOT_FOUND');
    expect(await storedStatus(order.id)).toBe('NEW');
  });

  it('C2: an order that does not exist is 404 ORDER_NOT_FOUND', async () => {
    const userId = await createUser(0);

    const res = await api.post('/orders/2147483647/cancel').send({ userId });

    expectError(res, 404, 'ORDER_NOT_FOUND');
  });

  it.each([
    ['an order id that is not a positive integer', '/orders/abc/cancel', { userId: 1 }],
    ['an order id above 32 bits', '/orders/2147483648/cancel', { userId: 1 }],
    ['a body without userId', '/orders/1/cancel', {}],
    ['a userId that is not an id', '/orders/1/cancel', { userId: '1' }],
    ['an unknown field', '/orders/1/cancel', { userId: 1, reason: 'x' }],
  ])('C2: %s is 400 VALIDATION_ERROR', async (_name, path, body) => {
    expectError(await api.post(path).send(body), 400, 'VALIDATION_ERROR');
  });
});
