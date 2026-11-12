import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 20_000,
    env: { NODE_ENV: 'test' },
  },
});
