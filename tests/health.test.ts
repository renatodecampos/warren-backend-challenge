import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { api, pool } from './helpers';
import { MIGRATION_SQL } from './test-env';

afterAll(() => pool.end());

describe('GET /health', () => {
  it('H1: is 200 with the database up', async () => {
    const res = await api.get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('database', () => {
  it('D1: the base file and the migration apply, and the migration can run twice', async () => {
    const seeded = await pool.query<{ users: string; instruments: string; orders: string }>(
      `SELECT (SELECT count(*) FROM users)       AS users,
              (SELECT count(*) FROM instruments) AS instruments,
              (SELECT count(*) FROM orders)      AS orders`,
    );
    expect(Number(seeded.rows[0]?.users)).toBeGreaterThan(0);
    expect(Number(seeded.rows[0]?.instruments)).toBeGreaterThan(0);
    expect(Number(seeded.rows[0]?.orders)).toBeGreaterThan(0);

    await pool.query(readFileSync(MIGRATION_SQL, 'utf8'));

    const columns = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'orders'`,
    );
    const nullable = new Map(columns.rows.map((c) => [c.column_name, c.is_nullable === 'YES']));
    expect(nullable.get('rejection_reason')).toBe(true);
    expect(nullable.get('idempotency_key')).toBe(true);
    expect(nullable.get('request_hash')).toBe(true);
    expect(nullable.get('price')).toBe(true);
    for (const column of ['instrumentid', 'userid', 'side', 'size', 'type', 'status', 'datetime']) {
      expect(nullable.get(column), column).toBe(false);
    }
  });

  it('D1: the constraints refuse an invalid order', async () => {
    const insert = (side: string, size: number) =>
      pool.query(
        `INSERT INTO orders (instrumentid, userid, side, size, price, type, status, datetime)
         VALUES (1, 1, $1, $2, 10, 'MARKET', 'FILLED', now())`,
        [side, size],
      );

    await expect(insert('GIFT', 1)).rejects.toThrow(/orders_side_chk/);
    await expect(insert('BUY', 0)).rejects.toThrow(/orders_size_chk/);
  });

  it('D1: the constraints refuse an invalid type, an invalid status and a duplicate idempotency key', async () => {
    const client = await pool.connect();
    const insert = (type: string, status: string, key: string | null) =>
      client.query(
        `INSERT INTO orders (instrumentid, userid, side, size, price, type, status, idempotency_key, datetime)
         VALUES (1, 1, 'BUY', 1, 10, $1, $2, $3, now())`,
        [type, status, key],
      );

    try {
      await client.query('BEGIN');

      await client.query('SAVEPOINT s');
      await expect(insert('STOP', 'FILLED', null)).rejects.toThrow(/orders_type_chk/);
      await client.query('ROLLBACK TO SAVEPOINT s');

      await client.query('SAVEPOINT s');
      await expect(insert('MARKET', 'OPEN', null)).rejects.toThrow(/orders_status_chk/);
      await client.query('ROLLBACK TO SAVEPOINT s');

      await insert('MARKET', 'FILLED', 'd1-duplicate');
      await client.query('SAVEPOINT s');
      await expect(insert('MARKET', 'FILLED', 'd1-duplicate')).rejects.toThrow(/uq_orders_user_idempotency_key/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
