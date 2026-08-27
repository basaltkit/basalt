import { defineConfig } from 'vitest/config'

// The e2e handshake spawns a child process (the built bin); a generous timeout
// keeps it reliable on shared CI runners.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
