import type { Pool } from 'pg';

/** The asset search (spec, section 4.2). */

export interface Instrument {
  id: number;
  ticker: string;
  name: string;
  type: string;
}

const CASH_TYPE = 'MONEDA';

/** Makes `%`, `_` and the escape character itself literal inside a `LIKE` pattern. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

export async function searchInstruments(pool: Pool, q: string, limit: number, offset: number): Promise<Instrument[]> {
  const found = await pool.query<Instrument>(
    `SELECT id, ticker, name, type
       FROM instruments
      WHERE type IS DISTINCT FROM $1
        AND (ticker ILIKE '%' || $2 || '%' ESCAPE '\\' OR name ILIKE '%' || $2 || '%' ESCAPE '\\')
      ORDER BY CASE
                 WHEN lower(ticker) = lower($3) THEN 0
                 WHEN ticker ILIKE $2 || '%' ESCAPE '\\' THEN 1
                 WHEN name ILIKE $2 || '%' ESCAPE '\\' THEN 2
                 ELSE 3
               END,
               ticker,
               id
      LIMIT $4 OFFSET $5`,
    [CASH_TYPE, escapeLike(q), q, limit, offset],
  );
  return found.rows;
}
