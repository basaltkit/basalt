import { defineConfig } from 'vitest/config'

/**
 * Root config for aggregate coverage across the workspace. Uses vitest
 * "projects" so packages with their own config (jsdom for the admin UIs) keep
 * their environment while coverage is collected from all of them at once.
 *
 *   pnpm test:coverage
 */
export default defineConfig({
  test: {
    projects: ['packages/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/dist/**', '**/*.d.ts', '**/index.ts'],
      thresholds: {
        statements: 70,
        functions: 70,
        lines: 70,
        branches: 60,
      },
    },
  },
})
