import { Pool, type PoolClient } from 'pg';

/**
 * Timeouts are set on every connection so a stuck transaction cannot hold a user's lock
 * indefinitely (spec, section 5; ADR 0003).
 */
export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3_000,
    lock_timeout: 2_000,
    statement_timeout: 5_000,
  });
}

/**
 * Runs `work` in one `READ COMMITTED` transaction: committed if it returns, rolled back if it
 * throws, so a refused request stores nothing (spec, section 4.3).
 */
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return run(pool, 'BEGIN ISOLATION LEVEL READ COMMITTED', work);
}

/**
 * Runs `work` on one consistent snapshot of the database. Read only, and it takes no lock, so it
 * never waits for a write (spec, section 4.1).
 */
export async function readSnapshot<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return run(pool, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', work);
}

async function run<T>(pool: Pool, begin: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
