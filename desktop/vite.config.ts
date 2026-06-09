import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    // Vite 8 defaults to baseline-widely-available (safari16.4+), which
    // requires macOS 13+. Tauri on macOS 12 uses Safari 15 WebView.
    target: ['es2021', 'safari15'],
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') return
        warn(warning)
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    // Dev-only: proxy backend traffic so the renderer talks to the API
    // server through the same Vite origin. This avoids CORS and the
    // loopback-clears-H5-auth path that breaks the standalone-browser
    // dev workflow. Electron production path is unaffected because
    // Electron sets the base URL via IPC at runtime.
    proxy: {
      '/health': 'http://127.0.0.1:3456',
      '/api': 'http://127.0.0.1:3456',
      '/ws': { target: 'ws://127.0.0.1:3456', ws: true },
      '/local-file': 'http://127.0.0.1:3456',
      '/preview-fs': 'http://127.0.0.1:3456',
    },
  },
})
