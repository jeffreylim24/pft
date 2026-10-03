/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const goServer = 'localhost:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': `http://${goServer}`,
      // No changeOrigin here: the Go server accepts a WebSocket only when its
      // Origin matches its Host, so Host must stay the one the browser sent.
      '/ws': { target: `ws://${goServer}`, ws: true },
    },
  },
  test: {
    environment: 'node',
    // Node 25 has its own localStorage global, which hides jsdom's.
    execArgv: ['--no-experimental-webstorage'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
