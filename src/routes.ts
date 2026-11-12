import { Router } from 'express';
import type { Pool } from 'pg';
import { AppError } from './errors';

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

  return router;
}
