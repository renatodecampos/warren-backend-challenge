import { Client, type Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { getPortfolio } from '../src/portfolio';
import { api, expectError, pool } from './helpers';
import { testDbUrl } from './test-env';

afterAll(() => pool.end());

/** Instruments of the seed that have no row in `marketdata`. */
const UNPRICED = 3;
const UNPRICED_TOO = 10;
/** Seed instrument; this file gives it a close of zero. */
const ZERO_CLOSE = 13;
const PAMP = 47;

async function createUser(): Promise<number> {
  const created = await pool.query<{ id: number }>(
    `INSERT INTO users (email, accountnumber) VALUES ('portfolio@test.com', '20001') RETURNING id`,
  );
  return created.rows[0]!.id;
}

type OrderRow = [instrumentId: number, side: string, size: number, price: number, status: string, type: string];

async function insertOrders(userId: number, orders: OrderRow[]) {
  for (const [index, [instrumentId, side, size, price, status, type]] of orders.entries()) {
    await pool.query(
      `INSERT INTO orders (instrumentid, userid, side, size, price, status, type, datetime)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TIMESTAMP '2023-07-12 10:00:00' + make_interval(mins => $8))`,
      [instrumentId, userId, side, size, price, status, type, index],
    );
  }
}

describe('GET /users/:userId/portfolio', () => {
  it('P1: the seed portfolio equals the example of the spec, field by field', async () => {
    const res = await api.get('/users/1/portfolio');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: 1,
      accountNumber: '10001',
      currency: 'ARS',
      totalAccountValue: 904784,
      cashBalance: 753000,
      reservedCash: 125500,
      availableBalance: 627500,
      positions: [
        {
          instrumentId: 54,
          ticker: 'METR',
          name: 'MetroGAS S.A.',
          quantity: 500,
          averageCost: 250,
          marketPrice: 229.5,
          marketValue: 114750,
          totalReturnPercent: -8.2,
          dailyReturnPercent: -1.08,
          priceAvailable: true,
        },
        {
          instrumentId: 47,
          ticker: 'PAMP',
          name: 'Pampa Holding S.A.',
          quantity: 40,
          averageCost: 930,
          marketPrice: 925.85,
          marketValue: 37034,
          totalReturnPercent: -0.45,
          dailyReturnPercent: 0.44,
          priceAvailable: true,
        },
      ],
    });
  });

  it('P1: the oversold instrument 31 is not listed', async () => {
    const res = await api.get('/users/1/portfolio');

    const listed = (res.body.positions as { instrumentId: number }[]).map((p) => p.instrumentId);
    expect(listed).toEqual([54, 47]);
  });

  it('P2: a position without a market price is valued at cost, with null returns', async () => {
    const userId = await createUser();
    await insertOrders(userId, [
      [66, 'CASH_IN', 10_000, 1, 'FILLED', 'MARKET'],
      [UNPRICED, 'BUY', 10, 12.34, 'FILLED', 'MARKET'],
    ]);

    const res = await api.get(`/users/${userId}/portfolio`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId,
      accountNumber: '20001',
      currency: 'ARS',
      totalAccountValue: 10000,
      cashBalance: 9876.6,
      reservedCash: 0,
      availableBalance: 9876.6,
      positions: [
        {
          instrumentId: UNPRICED,
          ticker: 'PGR',
          name: 'Phoenix Global Resources',
          quantity: 10,
          averageCost: 12.34,
          marketPrice: null,
          marketValue: 123.4,
          totalReturnPercent: null,
          dailyReturnPercent: null,
          priceAvailable: false,
        },
      ],
    });
  });

  it('4.1: uses the latest non-null close, and the daily return is null when previousClose is zero', async () => {
    await pool.query(
      `INSERT INTO marketdata (instrumentid, date, close, previousclose) VALUES
         ($1, '2023-07-13', 50, 0),
         ($1, '2023-07-14', NULL, 50)`,
      [UNPRICED_TOO],
    );
    const userId = await createUser();
    await insertOrders(userId, [
      [66, 'CASH_IN', 1_000, 1, 'FILLED', 'MARKET'],
      [UNPRICED_TOO, 'BUY', 3, 40, 'FILLED', 'MARKET'],
    ]);

    const res = await api.get(`/users/${userId}/portfolio`);

    expect(res.body.totalAccountValue).toBe(880 + 150);
    expect(res.body.positions).toEqual([
      expect.objectContaining({
        instrumentId: UNPRICED_TOO,
        marketPrice: 50,
        marketValue: 150,
        totalReturnPercent: 25,
        dailyReturnPercent: null,
        priceAvailable: true,
      }),
    ]);
  });

  it('4.1: a user without orders has an empty portfolio', async () => {
    const userId = await createUser();

    const res = await api.get(`/users/${userId}/portfolio`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalAccountValue: 0,
      cashBalance: 0,
      reservedCash: 0,
      availableBalance: 0,
      positions: [],
    });
  });

  it('P3: an unknown user is 404 USER_NOT_FOUND', async () => {
    expectError(await api.get('/users/999999/portfolio'), 404, 'USER_NOT_FOUND');
  });

  it('P4: a close of zero is no price', async () => {
    await pool.query(
      `INSERT INTO marketdata (instrumentid, date, close, previousclose)
       VALUES ($1, '2023-07-17', 0, 20.5)`,
      [ZERO_CLOSE],
    );
    const userId = await createUser();
    await insertOrders(userId, [
      [66, 'CASH_IN', 1_000, 1, 'FILLED', 'MARKET'],
      [ZERO_CLOSE, 'BUY', 5, 20, 'FILLED', 'MARKET'],
    ]);

    const res = await api.get(`/users/${userId}/portfolio`);

    expect(res.body.positions).toEqual([
      expect.objectContaining({
        instrumentId: ZERO_CLOSE,
        marketPrice: null,
        marketValue: 100,
        totalReturnPercent: null,
        dailyReturnPercent: null,
        priceAvailable: false,
      }),
    ]);
  });

  it('P5: averageCost rounds to the cent', async () => {
    const userId = await createUser();
    await insertOrders(userId, [
      [66, 'CASH_IN', 10_000, 1, 'FILLED', 'MARKET'],
      [UNPRICED, 'BUY', 2, 10, 'FILLED', 'MARKET'],
      [UNPRICED, 'BUY', 1, 10.01, 'FILLED', 'MARKET'],
    ]);

    const res = await api.get(`/users/${userId}/portfolio`);

    // A cost of 3,001 cents over 3 shares is 10.003..., rounded to the cent: 10.00.
    expect(res.body.positions[0]).toMatchObject({ quantity: 3, averageCost: 10, marketValue: 30.01 });
  });

  it('4.1: both account-state queries read one snapshot', async () => {
    const userId = await createUser();
    await insertOrders(userId, [[66, 'CASH_IN', 10_000, 1, 'FILLED', 'MARKET']]);
    const writer = new Client({ connectionString: testDbUrl() });
    await writer.connect();
    let injected = false;
    try {
      // The portfolio reads FILLED orders, then NEW ones. A committed order is injected between the
      // two: a REPEATABLE READ snapshot must not see it, while READ COMMITTED would reserve 9,000.
      const snapshotPool = {
        connect: async () => {
          const client = await pool.connect();
          const original = client.query.bind(client) as unknown as (
            text: string,
            values?: unknown[],
          ) => Promise<unknown>;
          (client as unknown as { query: typeof original }).query = async (text, values) => {
            const result = await original(text, values);
            if (!injected && text.includes("status = 'FILLED'")) {
              injected = true;
              await writer.query(
                `INSERT INTO orders (instrumentid, userid, side, size, price, type, status, datetime)
                 VALUES ($1, $2, 'BUY', 10, 900, 'LIMIT', 'NEW', now())`,
                [PAMP, userId],
              );
            }
            return result;
          };
          return client;
        },
      } as unknown as Pool;

      const result = await getPortfolio(snapshotPool, userId);

      expect(injected).toBe(true);
      expect(result.cashBalance).toBe(10_000);
      expect(result.reservedCash).toBe(0);
      expect(result.availableBalance).toBe(10_000);
    } finally {
      await writer.end();
    }
  });

  it.each(['abc', '0', '-1', '1.5', '2147483648'])('P3: the id "%s" is 400 VALIDATION_ERROR', async (id) => {
    expectError(await api.get(`/users/${id}/portfolio`), 400, 'VALIDATION_ERROR');
  });
});
