import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'renderer'),
  base: './',
  // `renderer/public/` is copied to `dist/renderer/` as-is. We stage the
  // glyph PBFs (fetched via scripts/fetch-fonts.mjs) under
  // `public/fonts/<fontstack>/<range>.pbf` so MapLibre can request them
  // via a relative URL that resolves correctly inside the packaged exe.
  publicDir: 'public',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@openmaps/core': resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
});
