import { defineConfig } from 'vitest/config'

// The server tests spawn a fake ssh (a Node process) per call: generous
// timeouts keep shared CI runners from flaking. Client tests opt into jsdom
// per file (`// @vitest-environment jsdom`).
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
