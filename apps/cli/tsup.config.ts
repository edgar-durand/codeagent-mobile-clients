import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    target: 'node18',
    clean: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: ['src/postinstall.ts'],
    format: ['cjs'],
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
