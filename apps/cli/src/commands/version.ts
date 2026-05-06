import pc from 'picocolors';

/**
 * Version string injected at build time by tsup's `define` config from
 * the CLI's own package.json. Single source of truth — no hardcoded
 * literal here. Falls back to the literal string `unknown` if a non-
 * tsup build runs this file (e.g. dev tests via tsx); the prod build
 * always replaces it.
 */
declare const __CLI_VERSION__: string;

export function version(): void {
  // The `typeof` guard keeps tsx/vitest happy when the define wasn't
  // applied — they would otherwise see `__CLI_VERSION__ is not defined`.
  const v = typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : 'unknown';
  console.log(`${pc.bold('codeam-cli')} ${pc.cyan(v)}`);
}
