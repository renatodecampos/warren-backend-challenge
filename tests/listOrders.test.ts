import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, CASH, createUser, expectError, pool } from './helpers';

afterAll(() => pool.end());

/** Seed instrument. PAMP's latest close is 925.85. */
const PAMP = 47;

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface ListedOrder {
  id: number;
  status: string;
}

/** One user with, oldest first: the deposit, a FILLED buy, an open LIMIT, a REJECTED buy, a CANCELLED LIMIT. */
let userId: number;
let filled: number;
let open: number;
let rejected: number;
let cancelled: number;

async function place(body: Record<string, unknown>): Promise<number> {
  const res = await api.post('/orders').send({ userId, instrumentId: PAMP, side: 'BUY', ...body });
  expect(res.status).toBe(201);
  return (res.body as ListedOrder).id;
}

async function list(query: Record<string, unknown>): Promise<ListedOrder[]> {
  const res = await api.get('/orders').query(query);
  expect(res.status).toBe(200);
  return res.body as ListedOrder[];
}

beforeAll(async () => {
  userId = await createUser(100_000);
  filled = await place({ type: 'MARKET', size: 10 });
  open = await place({ type: 'LIMIT', size: 10, price: 900 });
  rejected = await place({ type: 'MARKET', size: 1_000 });
  cancelled = await place({ type: 'LIMIT', size: 1, price: 900 });
  await api.post(`/orders/${cancelled}/cancel`).send({ userId });
});

describe('GET /orders', () => {
  it("L1: lists the user's orders newest first, in the shape of POST /orders", async () => {
    const res = await api.get('/orders').query({ userId });

    expect(res.status).toBe(200);
    const orders = res.body as ListedOrder[];
    expect(orders.map((order) => order.status)).toEqual(['CANCELLED', 'REJECTED', 'NEW', 'FILLED', 'FILLED']);
    expect(orders.slice(0, 4).map((order) => order.id)).toEqual([cancelled, rejected, open, filled]);
    expect(orders[1]).toEqual({
      id: rejected,
      userId,
      instrumentId: PAMP,
      ticker: 'PAMP',
      side: 'BUY',
      type: 'MARKET',
      size: 1_000,
      price: 925.85,
      status: 'REJECTED',
      rejectionReason: 'INSUFFICIENT_FUNDS',
      datetime: expect.stringMatching(DATETIME),
    });
    // The deposit is an order too (ADR 0001).
    expect(orders[4]).toMatchObject({ instrumentId: CASH, ticker: 'ARS', side: 'CASH_IN', size: 100_000, price: 1 });
  });

  it("L1: does not list another user's orders", async () => {
    const other = await createUser(0);

    const orders = await list({ userId: other });

    expect(orders).toEqual([]);
  });

  it.each([
    ['NEW', () => [open]],
    ['REJECTED', () => [rejected]],
    ['CANCELLED', () => [cancelled]],
  ])('L1: status=%s lists only those orders', async (status, expected) => {
    const orders = await list({ userId, status });

    expect(orders.map((order) => order.id)).toEqual(expected());
  });

  it('L1: status=FILLED lists the fill and the deposit', async () => {
    const orders = await list({ userId, status: 'FILLED' });

    expect(orders).toHaveLength(2);
    expect(orders[0]!.id).toBe(filled);
  });

  it('L1: limit and offset page through the list', async () => {
    expect((await list({ userId, limit: 2 })).map((order) => order.id)).toEqual([cancelled, rejected]);
    expect((await list({ userId, limit: 2, offset: 2 })).map((order) => order.id)).toEqual([open, filled]);
    expect(await list({ userId, offset: 5 })).toEqual([]);
  });

  it('L1: a user that does not exist gets an empty array', async () => {
    expect(await list({ userId: 2_147_483_647 })).toEqual([]);
  });

  it.each([
    ['no userId', {}],
    ['a userId that is not an id', { userId: 'abc' }],
    ['a status that is not one of the four', { userId: 1, status: 'OPEN' }],
    ['a limit of zero', { userId: 1, limit: 0 }],
    ['a limit above 100', { userId: 1, limit: 101 }],
    ['a negative offset', { userId: 1, offset: -1 }],
    ['an offset above 32 bits', { userId: 1, offset: 2_147_483_648 }],
    ['an unknown field', { userId: 1, side: 'BUY' }],
  ])('L1: %s is 400 VALIDATION_ERROR', async (_name, query) => {
    expectError(await api.get('/orders').query(query), 400, 'VALIDATION_ERROR');
  });
});
