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
      // Floor set just under the actual aggregate so CI protects the coverage
      // we have without blocking on hard-to-unit-test surfaces (CLI entry points,
      // cloud/service drivers, codegen renderers). Re-baselined 2026-08 to the real
      // aggregate (stmts/lines ~88%, funcs ~90%, branches ~85%) after the coverage
      // gate began running in CI. Raise these as the tail gets covered. (branches 85->84 after Zod 4: the
      // hand-rolled v3 zodToJsonSchema fallback is unreachable when the suite runs
      // on zod 4 — it exists for zod-3 consumers.)
      // without flaking on a normal PR. Ratchet up as coverage improves.
      thresholds: {
        statements: 87,
        functions: 87,
        lines: 87,
        branches: 84,
      },
    },
  },
})
