import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 27101,
    proxy: {
      '/api': 'http://127.0.0.1:27100',
    },
  },
});
