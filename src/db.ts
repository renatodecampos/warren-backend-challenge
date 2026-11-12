import { Pool } from 'pg';

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
