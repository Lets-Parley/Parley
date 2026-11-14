/// <reference types="vitest/config" />
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const fontExts = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot'])

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    assetsInlineLimit(filePath) {
      if (fontExts.has(path.extname(filePath))) {
        return false
      }
      return undefined
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    css: false,
  },
})
