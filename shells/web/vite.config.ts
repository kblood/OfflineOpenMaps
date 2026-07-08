import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// sqlite-wasm ships a .wasm binary that the bundler must serve as-is.
// We set crossOriginIsolated headers so SharedArrayBuffer (used by the
// OPFS sync-access variant) is available; the in-memory MVP works without
// them, but enabling early avoids a config gotcha when OPFS lands.
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  // Glyph PBFs live under `public/fonts/<fontstack>/<range>.pbf` — copied
  // as-is to the build output so MapLibre can request them via a relative
  // URL. (See buildMapStyle.ts's `glyphs:` field.)
  publicDir: 'public',
  // sqlite-wasm includes worker scripts and a .wasm file that Vite must
  // not try to transform. The package is ESM-only and resolves correctly
  // with default config; we just need to make sure the .wasm is bundled
  // as an asset.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: true,
  },
  server: {
    port: 5174,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    port: 5174,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  resolve: {
    alias: {
      '@openmaps/core': resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
});
