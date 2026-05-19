import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@openmaps/core': path.resolve(here, '../core/src/index.ts'),
    },
  },
  ssr: {
    // node:sqlite is a Node built-in (experimental in 22, stable in 24).
    // Vite doesn't recognize node: prefixed builtins out of the box.
    external: ['node:sqlite'],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    pool: 'forks',
    server: {
      deps: {
        external: [/^node:/],
      },
    },
  },
});
