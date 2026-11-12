import { join } from 'node:path';

export const TEST_DB_NAME = 'warren_challenge_test';

export const DB_DIR = join(__dirname, '..', 'db');
export const BASE_SQL = join(DB_DIR, 'database.sql');
export const MIGRATION_SQL = join(DB_DIR, 'migrations', '001_constraints_indexes.sql');

export const adminUrl = (): string =>
  process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';

export const testDbUrl = (): string => {
  const url = new URL(adminUrl());
  url.pathname = `/${TEST_DB_NAME}`;
  return url.toString();
};
