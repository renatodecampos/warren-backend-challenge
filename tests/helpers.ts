import request, { type Response } from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app';
import { createPool } from '../src/db';
import { testDbUrl } from './test-env';

export const pool = createPool(testDbUrl());
export const api = request(createApp(pool));

/** The one error shape of the API (spec, section 2): exactly `{ error: { code, message } }`. */
export function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message']);
  expect(res.body.error.code).toBe(code);
  expect(typeof res.body.error.message).toBe('string');
  expect(res.body.error.message.length).toBeGreaterThan(0);
}
