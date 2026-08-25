import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // @basaltkit/admin only needs randomUUID from crypto in the browser
      crypto: fileURLToPath(new URL('./src/crypto-shim.ts', import.meta.url)),
    },
  },
  server: { port: 5174 },
})
