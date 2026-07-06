import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against the shared package's workspace SOURCE, not the
      // built `dist/` its publishable manifest points at. Mirrors the
      // esbuild alias in esbuild.js and the tsconfig `paths` entry.
      '@codeam/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.ts', 'src/**/__tests__/**/*.ts'],
    testTimeout: 5_000,
  },
});
