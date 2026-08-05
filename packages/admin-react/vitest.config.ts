import { defineConfig } from 'vitest/config'

export default defineConfig({
  // esbuild's automatic JSX runtime — no need to import React in every file
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: { environment: 'jsdom' },
})
