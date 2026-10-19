import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration. The Electron/renderer bundling lives in
 * electron.vite.config.ts; this file only drives the unit test runner.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 10_000
  }
});
