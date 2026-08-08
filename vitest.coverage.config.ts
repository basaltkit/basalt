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
      // Floor set just under the actual aggregate (stmts/lines ~92%, branches
      // ~88%, funcs ~90% as of 0.31.0) so CI protects the coverage we have
      // without flaking on a normal PR. Ratchet up as coverage improves.
      thresholds: {
        statements: 90,
        functions: 87,
        lines: 90,
        branches: 85,
      },
    },
  },
})
