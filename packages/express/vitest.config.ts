import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Shared default: HTTP-flow tests (boot an app, run several requests, hash
// passwords) intermittently exceed vitest's 5s default on shared CI runners.
// A generous timeout keeps CI reliable without weakening anything.
//
// `@basaltkit/http` is resolved to its source, not its `dist`: the adapter and
// the shared pipeline evolve together, and a stale `dist` (any local run that
// skipped `pnpm build`) made this suite exercise the wrong pipeline — or fail
// outright on exports the build did not have yet. CI builds first anyway; this
// keeps `pnpm --filter <adapter> test` honest without it.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@basaltkit\/http$/,
        replacement: fileURLToPath(new URL('../http/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
