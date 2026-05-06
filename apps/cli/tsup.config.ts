import { defineConfig } from 'tsup';
import pkg from './package.json';

// Single source of truth for the version: package.json. tsup's
// `define` substitutes the `__CLI_VERSION__` literal in our source
// at build time so `codeam --version` always matches what npm
// published (the release pipeline patches package.json first).
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    target: 'node18',
    clean: true,
    noExternal: ['@clack/prompts', '@clack/core'],
    banner: { js: '#!/usr/bin/env node' },
    define: {
      __CLI_VERSION__: JSON.stringify(pkg.version),
    },
  },
  {
    entry: ['src/postinstall.ts'],
    format: ['cjs'],
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
