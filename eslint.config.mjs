// ────────────────────────────────────────────────────────────────────────────
// LINT TEMPORARILY DISABLED — reason: ESLint is incompatible with the current
// TypeScript version. typescript-eslint does not yet officially support TS >= 7
// (the monorepo uses the TS 7 toolchain; the root is pinned to TS 5.9 for lint
// only). Meanwhile, `pnpm lint` is a documented no-op — see the `lint` script in
// package.json (the real command is preserved as `lint:eslint`).
//
// This config was NOT removed or altered on purpose: once the ESLint ecosystem
// has official support, lint can be re-enabled with NO architectural change —
// just restore `"lint": "eslint ."` in package.json (or run `pnpm lint:eslint`).
// `typecheck` stays active and keeps validating types.
// ────────────────────────────────────────────────────────────────────────────
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/generated/**',
      '**/.vitepress/cache/**',
      '**/.vitepress/dist/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // `any` is used deliberately in a few adapter/generator spots.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
)
