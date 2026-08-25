import { defineConfig } from 'vitest/config'

// scrypt password hashing (N=2^16) is intentionally slow; on shared CI runners a
// register+login test can exceed vitest's 5s default. Give crypto tests headroom.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
