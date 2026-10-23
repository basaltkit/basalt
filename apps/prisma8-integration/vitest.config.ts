import { defineConfig } from 'vitest/config'

// Pins this project's vitest configuration (see apps/pg-integration/vitest.config.ts).
// One database, one set of schemas: files run serially.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/support/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
