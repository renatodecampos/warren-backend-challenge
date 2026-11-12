import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { BASE_SQL, MIGRATION_SQL, TEST_DB_NAME, adminUrl, testDbUrl } from './test-env';

// Recreates an isolated database from the base file and the migration, so every run starts clean.
export default async function setup() {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  await admin.end();

  const db = new Client({ connectionString: testDbUrl() });
  await db.connect();
  await db.query(readFileSync(BASE_SQL, 'utf8'));
  await db.query(readFileSync(MIGRATION_SQL, 'utf8'));
  await db.end();
}
