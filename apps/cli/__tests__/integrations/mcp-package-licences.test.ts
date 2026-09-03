import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { INTEGRATION_REGISTRY } from '@codeam/shared';

/**
 * Every npm-delivered MCP server we pin must be FREE to use — and the registry
 * has to prove it, because the agent cannot.
 *
 * On 2026-09-03 `@taazkareem/clickup-mcp-server` was pinned at 0.14.4. The
 * server connected, found the user's workspace… and every tool answered
 * "LIMITED": the maintainer had gone `Proprietary` at 0.13.0, shipping an
 * OBFUSCATED `build/license.js` that gates the tools behind a paid
 * `CLICKUP_MCP_LICENSE_KEY`. To the agent — and to the user — that looked
 * exactly like the connection failures we had spent the day fixing. The last
 * MIT release is 0.8.5.
 *
 * `npm view <pkg>@<version> license` is the cheapest reliable signal: the
 * licence field is set by the publisher and changed at exactly the version the
 * paywall arrived. This test asks the registry for it, so a future pin bump to
 * a paywalled version fails HERE, in CI, with the licence string in the
 * message — not on a user's box as "not connected".
 *
 * Network-dependent by design (it reads the registry). It runs in CI, where the
 * registry is reachable; skip it locally with RUN_NPM_LICENCE_CHECK=0.
 *
 * Lives in apps/cli rather than packages/shared on purpose: it shells out to
 * `npm view`, and packages/shared is a pure-TS package whose tsconfig has no
 * Node types — placing it there broke `tsc --noEmit` in the v2.73.8 release
 * (`Publish @codeam/shared to npm` failed on TS2591 for `node:child_process`).
 */

const FREE_LICENCES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'MPL-2.0',
  '0BSD',
  'Unlicense',
  // Copyleft, but free to run: we execute the server, we do not redistribute it.
  'AGPL-3.0-only',
  'AGPL-3.0',
  'GPL-3.0-only',
  // Sentry's Functional Source License: free to use, only competing use is
  // restricted, converts to Apache-2.0 after two years.
  'FSL-1.1-ALv2',
  'FSL-1.1-MIT',
]);

/**
 * Pins whose `license` field is EMPTY on npm but whose source is verifiably
 * free — checked by hand against the repository and recorded here with the
 * evidence, so the audit stays strict for everything else. Add to this list
 * only after reading the licence file in the repo, never to silence a red.
 */
const VERIFIED_FREE_WITHOUT_FIELD: Record<string, string> = {
  // The published tarball's README states "licensed under the MIT License";
  // package.json carries no `license`/`repository` field, so `npm view` prints
  // "". No licence gate in its code (grepped for license_key/paywall/polar).
  // Verified from the tarball itself, 2026-09-03.
  'mcp-linear@0.1.8': 'MIT per README in the published tarball; package.json omits the field',
};

/** `-y pkg@1.2.3 --flag` → `pkg@1.2.3`; the first non-flag argument. */
function npxSpec(args: readonly string[]): string | null {
  return args.find((a) => !a.startsWith('-')) ?? null;
}

const npxPins = Object.values(INTEGRATION_REGISTRY)
  .map((i) => ({ id: i.id, mcp: i.delivery?.mcp }))
  .filter((x) => x.mcp?.command === 'npx')
  .map((x) => ({ id: String(x.id), spec: npxSpec(x.mcp!.args ?? []) }))
  .filter((x): x is { id: string; spec: string } => x.spec !== null);

const enabled = process.env.RUN_NPM_LICENCE_CHECK !== '0';

describe.runIf(enabled)('every npx-delivered MCP server pin is a FREE licence', () => {
  it('finds the npx pins in the registry', () => {
    expect(npxPins.length).toBeGreaterThan(5);
  });

  for (const { id, spec } of npxPins) {
    it(`${id}: ${spec} is published under a free licence`, () => {
      // ⚠️ Windows needs a shell for npm, and ONLY Windows. Two failures in a
      // row taught this (2026-09-03): `execFileSync('npm')` → `ENOENT` (the
      // binary is `npm.cmd`), then `execFileSync('npm.cmd')` → `EINVAL`, because
      // Node ≥ 20.12 refuses to spawn .cmd/.bat WITHOUT a shell
      // (CVE-2024-27980). `shell: true` there resolves `npm` via cmd.exe like
      // a terminal would. Unix keeps the shell-less spawn — `spec` is a package
      // name from our own registry, never user input, so the shell path carries
      // no injection surface; the Unix path avoids it anyway.
      const win = process.platform === 'win32';
      const licence = execFileSync('npm', ['view', spec, 'license'], {
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: win,
      }).trim();
      if (licence === '' && VERIFIED_FREE_WITHOUT_FIELD[spec]) return;
      // A licence the maintainer changed to gate the tools reads as
      // `Proprietary` / `UNLICENSED` / `SEE LICENSE IN …` — none of which is
      // something we can ship to a user as "linked and working".
      expect(
        FREE_LICENCES.has(licence),
        `${spec} is published as "${licence}" — if the maintainer went paid, pin the LAST free version instead (see clickup)`,
      ).toBe(true);
    }, 90_000);
  }
});
