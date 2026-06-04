import fs from 'fs';
import path from 'path';

/**
 * Pre-flight Node.js dependency check. Returns the install command
 * to run when `package.json` exists but `node_modules/` is missing,
 * or `null` when no install is needed.
 *
 * Belt-and-braces around the agent-supplied `setup_commands` in
 * `PreviewDetection`. The agent normally emits `npm install` but
 * occasionally forgets, in which case the dev server crashes
 * immediately with "Cannot find module …" the moment it spawns and
 * the user sees a generic "Dev server exited" error.
 *
 * Skip-when-installed is deliberate: if `node_modules/` exists we
 * trust it. Comparing lockfile mtimes against `node_modules/.package-lock.json`
 * would let us catch stale installs, but the cost-benefit isn't
 * there — that case shows up as a dev-server runtime error which
 * the agent's normal output handling already surfaces.
 *
 * Package-manager detection by lockfile presence:
 *
 *   pnpm-lock.yaml  -> pnpm install
 *   yarn.lock       -> yarn install
 *   bun.lock(b)     -> bun install
 *   default         -> npm install
 *
 * Non-Node projects (no `package.json`) return null and let the
 * agent's `setup_commands` cover Python / Ruby / Go / Rust.
 */
export function detectMissingNodeDeps(
  cwd: string,
): { cmd: string; args: string[] } | null {
  if (!fs.existsSync(path.join(cwd, 'package.json'))) return null;
  if (fs.existsSync(path.join(cwd, 'node_modules'))) return null;

  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) {
    return { cmd: 'pnpm', args: ['install'] };
  }
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) {
    return { cmd: 'yarn', args: ['install'] };
  }
  if (
    fs.existsSync(path.join(cwd, 'bun.lockb')) ||
    fs.existsSync(path.join(cwd, 'bun.lock'))
  ) {
    return { cmd: 'bun', args: ['install'] };
  }
  return { cmd: 'npm', args: ['install'] };
}

/**
 * Detect whether a `PreviewDetection.setup_commands` entry is a
 * package-install command from any supported JS package manager.
 *
 * Used to skip the agent's install when the pre-flight already
 * ran one — the agent occasionally emits `npm install` for a
 * `pnpm-lock.yaml` project (or vice versa), and running a second
 * install with a different package manager on top of a
 * just-populated `node_modules/` crashes (pnpm's `.pnpm/` simlinked
 * layout breaks npm's tree resolver, npm errors with
 * `Cannot read properties of null (reading 'matches')` after
 * several minutes of `ERESOLVE` warnings — observed in prod).
 *
 * Returns true for: `npm install`, `npm i`, `npm ci`, `pnpm install`,
 * `pnpm i`, `yarn install`, plain `yarn` (yarn classic shortcut),
 * `bun install`, `bun i`. False for anything else (`prisma generate`,
 * `prebuild`, `make`, etc.) so non-install setup steps still run.
 */
export function isJsInstallCommand(cmd: string, args: string[]): boolean {
  const known = ['npm', 'pnpm', 'yarn', 'bun'];
  if (!known.includes(cmd)) return false;
  // `yarn` with no args == yarn classic "install everything"
  if (cmd === 'yarn' && args.length === 0) return true;
  const verb = args[0];
  return verb === 'install' || verb === 'i' || verb === 'ci';
}
