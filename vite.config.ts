import { defineConfig } from 'vite';

// Relative base: the build works from a GitHub Pages subpath and from disk.
export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0, chunkSizeWarningLimit: 900 },
  server: { host: '127.0.0.1', port: 5183 },
});
