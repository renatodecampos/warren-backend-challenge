import express from 'express';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp, errorHandler, requestContext } from '../src/app';
import { createPool } from '../src/db';
import { AppError } from '../src/errors';
import { api, expectError, pool } from './helpers';
import { testDbUrl } from './test-env';

afterAll(() => pool.end());

/** A small app with the real middleware and routes that fail in each way the handler knows. */
function failingApp() {
  const app = express();
  app.use(requestContext);
  app.get('/unexpected', () => {
    throw new Error('connect ECONNREFUSED 10.0.0.7:5432 password=hunter2');
  });
  app.get('/domain', () => {
    throw new AppError(409, 'ORDER_NOT_CANCELLABLE', 'Only NEW orders can be cancelled');
  });
  app.get('/invalid', () => {
    z.object({ size: z.number() }).parse({ size: 'ten' });
  });
  app.use(errorHandler);
  return request(app);
}

describe('E1: one error shape', () => {
  it('an unknown route is 404 NOT_FOUND', async () => {
    expectError(await api.get('/nothing-here'), 404, 'NOT_FOUND');
  });

  it('a body that is not JSON is 400 VALIDATION_ERROR', async () => {
    const res = await api.post('/orders').set('Content-Type', 'application/json').send('{ "userId": ');

    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('a malformed percent-encoded path is 400 VALIDATION_ERROR', async () => {
    expectError(await api.get('/users/%E0%A4%A/portfolio'), 400, 'VALIDATION_ERROR');
  });

  it('a body with a bad Content-Encoding is 400 VALIDATION_ERROR', async () => {
    const res = await api
      .post('/orders')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send('not gzip');

    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('a schema failure is 400 VALIDATION_ERROR and names the field', async () => {
    const res = await failingApp().get('/invalid');

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.message).toContain('size');
  });

  it('a domain error keeps its status, code and message', async () => {
    const res = await failingApp().get('/domain');

    expectError(res, 409, 'ORDER_NOT_CANCELLABLE');
    expect(res.body.error.message).toBe('Only NEW orders can be cancelled');
  });

  it('an unexpected error is 500 INTERNAL_ERROR and never shows internals', async () => {
    const res = await failingApp().get('/unexpected');

    expectError(res, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.7/);
  });

  it('health with the database down is 503 DATABASE_UNAVAILABLE', async () => {
    const deadPool = createPool('postgres://postgres:postgres@127.0.0.1:1/nowhere');

    const res = await request(createApp(deadPool)).get('/health');

    expectError(res, 503, 'DATABASE_UNAVAILABLE');
    await deadPool.end();
  });
});

describe('E1: X-Request-Id', () => {
  it('is on a success and on an error', async () => {
    const ok = await api.get('/health');
    const notFound = await api.get('/nothing-here');

    expect(ok.headers['x-request-id']).toMatch(/^[\w.-]{8,}$/);
    expect(notFound.headers['x-request-id']).toMatch(/^[\w.-]{8,}$/);
    expect(ok.headers['x-request-id']).not.toBe(notFound.headers['x-request-id']);
  });

  it('reuses an incoming id', async () => {
    const res = await api.get('/health').set('X-Request-Id', 'client-abc.123');

    expect(res.headers['x-request-id']).toBe('client-abc.123');
  });

  it('replaces an incoming id that is not a plain token', async () => {
    const res = await api.get('/health').set('X-Request-Id', 'a b <script>');

    expect(res.headers['x-request-id']).not.toContain(' ');
    expect(res.headers['x-request-id']).toMatch(/^[\w.-]{8,}$/);
  });
});

describe('E1: logs', () => {
  it('writes one JSON line with the request fields', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const sink = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const res = await api.get('/health');

      expect(res.status).toBe(200);
      expect(sink).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(sink.mock.calls[0]?.[0]));
      expect(line).toEqual({
        level: 'info',
        requestId: res.headers['x-request-id'],
        method: 'GET',
        path: '/health',
        status: 200,
        durationMs: expect.any(Number),
      });
    } finally {
      sink.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('writes an error line with the request id', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await failingApp().get('/unexpected');

      expectError(res, 500, 'INTERNAL_ERROR');
      expect(errors).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(errors.mock.calls[0]?.[0]));
      expect(line).toMatchObject({ level: 'error', requestId: res.headers['x-request-id'] });
      expect(line.message).toContain('ECONNREFUSED');
      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
      errors.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe('E1: pool errors', () => {
  it('an idle database client error does not terminate the process', async () => {
    const idlePool = createPool(testDbUrl());
    try {
      expect(() => idlePool.emit('error', new Error('idle client died'))).not.toThrow();
    } finally {
      await idlePool.end();
    }
  });
});

describe('E3: unknown query fields', () => {
  it.each(['/health', '/users/1/portfolio'] as const)('GET %s?foo=bar is 400 VALIDATION_ERROR', async (path) => {
    const res = await api.get(`${path}?foo=bar`);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.message).toContain('foo');
  });

  it.each(['/orders', '/orders/1/cancel', '/transfers'] as const)(
    'POST %s?foo=bar is 400 VALIDATION_ERROR before the body is read',
    async (path) => {
      const res = await api.post(`${path}?foo=bar`).send({});

      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.message).toContain('foo');
    },
  );
});

describe('E2: timeouts are 503 BUSY', () => {
  it('an order that waits longer than the lock timeout is 503 BUSY and stores nothing', async () => {
    const created = await pool.query<{ id: number }>(
      `INSERT INTO users (email, accountnumber) VALUES ('busy@test.com', '30002') RETURNING id`,
    );
    const userId = created.rows[0]!.id;
    // Another writer holds this user's lock for longer than `lock_timeout`.
    const holder = new Client({ connectionString: testDbUrl() });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

      const res = await api.post('/orders').send({ userId, ticker: 'PAMP', side: 'BUY', type: 'MARKET', size: 1 });

      expectError(res, 503, 'BUSY');
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    const stored = await pool.query('SELECT 1 FROM orders WHERE userid = $1', [userId]);
    expect(stored.rowCount).toBe(0);
  });

  it('a statement that runs longer than the statement timeout is 503 BUSY', async () => {
    const app = express();
    app.use(requestContext);
    app.get('/slow', async () => {
      const client = new Client({ connectionString: testDbUrl(), statement_timeout: 100 });
      await client.connect();
      try {
        await client.query('SELECT pg_sleep(2)');
      } finally {
        await client.end();
      }
    });
    app.use(errorHandler);

    const res = await request(app).get('/slow');

    expectError(res, 503, 'BUSY');
    expect(JSON.stringify(res.body)).not.toMatch(/statement|timeout|pg_sleep/i);
  });
});
