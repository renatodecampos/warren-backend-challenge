import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from './errors';
import { searchInstruments } from './instruments';
import { hasAtMostTwoDecimals, MAX_ORDER_SIZE } from './money';
import { submitOrder } from './orders';
import { getPortfolio } from './portfolio';

/** A positive 32-bit integer written in plain digits (spec, section 2). */
const id = z
  .string()
  .regex(/^[1-9]\d{0,9}$/, 'must be a positive integer')
  .transform(Number)
  .refine((value) => value <= 2_147_483_647, 'must be a positive 32-bit integer');

/** A whole number written in plain digits, as a query string carries it. */
const digits = z.string().regex(/^\d{1,10}$/, 'must be a whole number').transform(Number);

const searchQuery = z.strictObject({
  q: z.string().trim().min(1).max(100),
  limit: digits.refine((value) => value >= 1 && value <= 100, 'must be between 1 and 100').default(20),
  offset: digits.refine((value) => value <= 2_147_483_647, 'must be a 32-bit integer').default(0),
});

/** An id as a JSON body carries it: a number, not a string. */
const bodyId = z.number().int().min(1).max(2_147_483_647);

/** Pesos with at most two decimals (spec, section 2). */
const money = z.number().refine(hasAtMostTwoDecimals, 'must be an amount in pesos with at most two decimals');

const orderBody = z
  .strictObject({
    userId: bodyId,
    instrumentId: bodyId.optional(),
    ticker: z.string().min(1).max(10).optional(),
    side: z.enum(['BUY', 'SELL']),
    type: z.enum(['MARKET', 'LIMIT']),
    size: z.number().int().min(1).max(MAX_ORDER_SIZE).optional(),
    amount: money.optional(),
    price: money.refine((value) => value > 0, 'must be above zero').optional(),
  })
  .refine((body) => (body.instrumentId === undefined) !== (body.ticker === undefined), {
    path: ['instrumentId'],
    message: 'give exactly one of instrumentId and ticker',
  })
  .refine((body) => (body.size === undefined) !== (body.amount === undefined), {
    path: ['size'],
    message: 'give exactly one of size and amount',
  })
  .refine((body) => (body.type === 'LIMIT') === (body.price !== undefined), {
    path: ['price'],
    message: 'is required for LIMIT and refused for MARKET',
  });

/** The optional `Idempotency-Key` header: 1 to 50 printable ASCII characters (spec, section 4.3). */
const idempotencyHeader = z.object({
  'idempotency-key': z
    .string()
    .regex(/^[\x20-\x7E]{1,50}$/, 'must be 1 to 50 printable ASCII characters')
    .optional(),
});

export function createRoutes(pool: Pool): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
    } catch {
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The database is not answering');
    }
    res.json({ status: 'ok' });
  });

  router.get('/users/:userId/portfolio', async (req, res) => {
    const { userId } = z.object({ userId: id }).parse(req.params);
    res.json(await getPortfolio(pool, userId));
  });

  router.get('/instruments', async (req, res) => {
    const { q, limit, offset } = searchQuery.parse(req.query);
    res.json(await searchInstruments(pool, q, limit, offset));
  });

  router.post('/orders', async (req, res) => {
    const body = orderBody.parse(req.body);
    const key = idempotencyHeader.parse({ 'idempotency-key': req.get('idempotency-key') })['idempotency-key'];
    const { order, replayed } = await submitOrder(pool, body, key);
    res.status(replayed ? 200 : 201).json(order);
  });

  return router;
}
