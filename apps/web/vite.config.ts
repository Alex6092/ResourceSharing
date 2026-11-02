import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:3000', '/auth': 'http://127.0.0.1:3000', '/tus': 'http://127.0.0.1:3000', '/download': 'http://127.0.0.1:3000' } },
});
