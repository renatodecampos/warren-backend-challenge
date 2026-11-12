import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, expectError, pool } from './helpers';

/**
 * Instruments added to the seed for the ranking and the wildcard tests. `zqx` appears nowhere in
 * the seed, and neither do `%` or `_`.
 */
beforeAll(async () => {
  await pool.query(
    `INSERT INTO instruments (ticker, name, type) VALUES
       ('BZQX',  'Rest by ticker',     'ACCIONES'),
       ('CCC',   'Rest by name zqx',   'ACCIONES'),
       ('AAA1',  'Zqx second by name', 'ACCIONES'),
       ('AAA0',  'ZQX first by name',  'ACCIONES'),
       ('ZQXB',  'Prefix two',         'ACCIONES'),
       ('ZQXA',  'Prefix one',         'ACCIONES'),
       ('ZQX',   'Exact',              'ACCIONES'),
       ('PCT',   'Fifty% literal',     'ACCIONES'),
       ('UND',   'Under_score',        'ACCIONES')`,
  );
});

afterAll(() => pool.end());

const tickers = (body: unknown) => (body as { ticker: string }[]).map((instrument) => instrument.ticker);

describe('GET /instruments', () => {
  it('S1: finds by ticker, ignoring case, with id, ticker, name and type', async () => {
    const res = await api.get('/instruments').query({ q: 'pamp' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 47, ticker: 'PAMP', name: 'Pampa Holding S.A.', type: 'ACCIONES' }]);
  });

  it('S1: finds by name, ignoring case', async () => {
    const res = await api.get('/instruments').query({ q: 'METROGAS' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 54, ticker: 'METR', name: 'MetroGAS S.A.', type: 'ACCIONES' }]);
  });

  it('S1: matches a substring in the middle of a name', async () => {
    const res = await api.get('/instruments').query({ q: 'holding' });

    expect(tickers(res.body)).toEqual(['CVH', 'HAVA', 'PAMP']);
  });

  it('4.2: q is trimmed before matching', async () => {
    const res = await api.get('/instruments').query({ q: '  pamp  ' });

    expect(tickers(res.body)).toEqual(['PAMP']);
  });

  it('S2: exact ticker, then ticker prefix, then name prefix, then the rest; ties by ticker', async () => {
    const res = await api.get('/instruments').query({ q: 'zqx' });

    expect(tickers(res.body)).toEqual(['ZQX', 'ZQXA', 'ZQXB', 'AAA0', 'AAA1', 'BZQX', 'CCC']);
  });

  it('S2: in the seed, the exact ticker TRAN comes before the names that start with it', async () => {
    const res = await api.get('/instruments').query({ q: 'tran' });

    expect(tickers(res.body)).toEqual(['TRAN', 'TGNO4', 'TGSU2']);
  });

  it.each(['ars', 'pesos'])('S3: the cash instrument is not returned for "%s"', async (q) => {
    const res = await api.get('/instruments').query({ q });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each([
    ['%', ['PCT']],
    ['_', ['UND']],
    ['\\', []],
  ])('S3: "%s" is a literal character, not a wildcard', async (q, expected) => {
    const res = await api.get('/instruments').query({ q });

    expect(res.status).toBe(200);
    expect(tickers(res.body)).toEqual(expected);
  });

  it('S3: q is required', async () => {
    expectError(await api.get('/instruments'), 400, 'VALIDATION_ERROR');
  });

  it.each(['', '   ', 'a'.repeat(101)])('S3: the q "%s" is 400 VALIDATION_ERROR', async (q) => {
    expectError(await api.get('/instruments').query({ q }), 400, 'VALIDATION_ERROR');
  });

  it('S3: a q of 100 characters is accepted', async () => {
    const res = await api.get('/instruments').query({ q: 'a'.repeat(100) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('S3: the page is 20 by default', async () => {
    const res = await api.get('/instruments').query({ q: 'a' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(20);
  });

  it('S3: limit goes up to 100', async () => {
    const res = await api.get('/instruments').query({ q: 'a', limit: '100' });

    expect(res.status).toBe(200);
    expect((res.body as unknown[]).length).toBeGreaterThan(20);
  });

  it.each(['101', '0', '-1', '1.5', 'abc', ''])('S3: the limit "%s" is 400 VALIDATION_ERROR', async (limit) => {
    expectError(await api.get('/instruments').query({ q: 'a', limit }), 400, 'VALIDATION_ERROR');
  });

  it.each(['-1', '1.5', 'abc', '', '2147483648'])('S3: the offset "%s" is 400 VALIDATION_ERROR', async (offset) => {
    expectError(await api.get('/instruments').query({ q: 'a', offset }), 400, 'VALIDATION_ERROR');
  });

  it('4.2: limit and offset page through the ranked result', async () => {
    const res = await api.get('/instruments').query({ q: 'zqx', limit: '2', offset: '3' });

    expect(tickers(res.body)).toEqual(['AAA0', 'AAA1']);
  });

  it('4.2: an unknown query field is 400 VALIDATION_ERROR', async () => {
    expectError(await api.get('/instruments').query({ q: 'a', sort: 'name' }), 400, 'VALIDATION_ERROR');
  });
});
