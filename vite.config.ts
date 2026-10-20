import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Dev server port (5173 → 8800). strictPort: 端口被占用时直接报错，而不是静默跳到 8801
    port: 8800,
    strictPort: true,
    proxy: {
      // Forward API requests to the Node backend (Hono on port 8787)
      '/api': {
        target: `http://localhost:${process.env.PORT || 8787}`,
        changeOrigin: true,
      },
      // Forward drawio self-hosted assets to the Node backend (production
      // serves them from /drawio/* on the same port; in dev, Vite would
      // otherwise hit its SPA fallback and 404).
      '/drawio': {
        target: `http://localhost:${process.env.PORT || 8787}`,
        changeOrigin: true,
      },
    },
  },
})
