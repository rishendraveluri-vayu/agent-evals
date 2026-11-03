import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// The dev and preview servers forward /api to the NestJS API, so the browser
// sees one origin, as it does behind nginx in Docker.
const apiProxy = {
  '/api': {
    target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [vue()],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
