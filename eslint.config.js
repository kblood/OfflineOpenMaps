// Flat ESLint config. The critical rule for v2: NO direct network calls
// from packages/core or packages/ui. The only allowed places to call fetch
// are packages/platform-node (Electron-side downloads) and packages/region-builder
// (the build pipeline).
//
// If you find yourself wanting to disable this rule, you're probably violating
// guarantee #2 from PLAN.md. Stop and route the call through an adapter instead.

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

const NO_NETWORK_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];

const noNetworkRule = {
  files: ['packages/core/**/*.ts', 'packages/ui/**/*.{ts,tsx}'],
  languageOptions: {
    parser: tsparser,
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
  plugins: { '@typescript-eslint': tseslint },
  rules: {
    'no-restricted-globals': [
      'error',
      ...NO_NETWORK_GLOBALS.map((name) => ({
        name,
        message:
          `Direct network calls are banned in core/ui. Route through an adapter ` +
          `(see packages/core/src/pack/RegionPack.ts). If this is the pack download ` +
          `flow, put it in shells/electron or platform-node.`,
      })),
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector: "Literal[value=/^https?:\\/\\//]",
        message:
          'Hardcoded http(s) URLs are banned in core/ui. v1 had Nominatim hardcoded; ' +
          'v2 reads everything from the local pack. If this is a pack-manifest URL, ' +
          'put it in user config, not source code.',
      },
    ],
  },
};

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.config.*', '**/vite.config.*'],
  },
  noNetworkRule,
];
