import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from './errors';
import { searchInstruments } from './instruments';
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

  return router;
}
