import { defineConfig } from 'vitest/config'

// Pins this project's vitest configuration. Without a config file here, vitest
// walks up the directory tree and can pick one up from OUTSIDE the repository
// (a stray config in a developer's home directory breaks the run with
// "Cannot find package 'vitest'"). The settings match the workspace default.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
