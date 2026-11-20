import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard talks to the Fastify API (apps/api) on localhost:3000.
// In dev, /api is proxied so the SPA and API share an origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/hooks': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
