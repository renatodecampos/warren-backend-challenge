import request, { type Response } from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app';
import { createPool } from '../src/db';
import { testDbUrl } from './test-env';

export const pool = createPool(testDbUrl());
export const api = request(createApp(pool));

/** The one error shape of the API (spec, section 2): exactly `{ error: { code, message } }`. */
export function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message']);
  expect(res.body.error.code).toBe(code);
  expect(typeof res.body.error.message).toBe('string');
  expect(res.body.error.message.length).toBeGreaterThan(0);
}

/** The cash instrument of the seed (`ARS`). */
export const CASH = 66;

/** A new user whose only history is a deposit of `cash` whole pesos. */
export async function createUser(cash: number): Promise<number> {
  const created = await pool.query<{ id: number }>(
    `INSERT INTO users (email, accountnumber) VALUES ('orders@test.com', '30001') RETURNING id`,
  );
  const userId = created.rows[0]!.id;
  if (cash > 0) await insertFilled(userId, CASH, 'CASH_IN', cash, 1);
  return userId;
}

export async function insertFilled(userId: number, instrumentId: number, side: string, size: number, price: number) {
  await pool.query(
    `INSERT INTO orders (instrumentid, userid, side, size, price, status, type, datetime)
     VALUES ($1, $2, $3, $4, $5, 'FILLED', 'MARKET', TIMESTAMP '2023-07-12 10:00:00')`,
    [instrumentId, userId, side, size, price],
  );
}
