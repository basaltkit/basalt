import { defineConfig } from 'vitest/config'

// Pins this project's vitest configuration. Without a config file here, vitest
// walks up the directory tree and can pick one up from OUTSIDE the repository
// (a stray config in a developer's home directory breaks the run with
// "Cannot find package 'vitest'").
//
// `fileParallelism: false` because every file in this suite talks to the SAME
// database: files that create roles, policies or SECURITY DEFINER functions
// race on the shared catalog ("tuple concurrently updated") when they run at
// the same time. Serial files keep the suite deterministic; it takes < 2s.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
