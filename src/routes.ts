import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from './errors';
import { getPortfolio } from './portfolio';

/** A positive 32-bit integer written in plain digits (spec, section 2). */
const id = z
  .string()
  .regex(/^[1-9]\d{0,9}$/, 'must be a positive integer')
  .transform(Number)
  .refine((value) => value <= 2_147_483_647, 'must be a positive 32-bit integer');

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

  return router;
}
