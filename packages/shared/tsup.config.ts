import { defineConfig } from 'tsup';

/**
 * Build for the PUBLISHED `@codeam/shared` artifact only.
 *
 * The workspace consumers (apps/cli via tsup, apps/vsc-plugin via esbuild)
 * do NOT consume this output — they bundle `src/index.ts` directly through
 * an explicit alias (see apps/cli/tsup.config.ts and apps/vsc-plugin/esbuild.js)
 * so their bundles are identical whether or not `dist/` exists. This build
 * exists solely so `npm publish` ships a resolvable dual CJS+ESM package
 * with type declarations for external consumers (repo A's api-v2, etc.).
 *
 * `zod` stays a runtime `dependency` and is therefore left external here
 * (tsup externalizes `dependencies` by default) — external consumers get it
 * via their own node_modules; the CLI/VS Code bundles inline it themselves.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
