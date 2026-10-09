import { defineConfig } from 'vitest/config'

// Shared default: HTTP-flow tests (boot an app, run several requests, hash
// passwords) intermittently exceed vitest's 5s default on shared CI runners.
// A generous timeout keeps CI reliable without weakening anything.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
