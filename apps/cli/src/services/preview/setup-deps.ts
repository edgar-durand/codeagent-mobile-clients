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
 * Package-manager choice (verified live on a fresh codespace):
 *
 *   yarn.lock  -> yarn install   (yarn honours yarn.lock; the caller
 *                                 ensures yarn is installed first — a
 *                                 fresh codespace ships node+npm only, so
 *                                 yarn install would ENOENT → "exit null".
 *                                 See `ensureYarnInstalled` at the call site.)
 *   everything  -> npm install --legacy-peer-deps
 *   else
 *
 * Why npm for pnpm/bun/default instead of the project's own PM:
 *   - pnpm ≥10 requires Node ≥22.13 (it imports `node:sqlite`), but
 *     codespaces ship Node 20 — `pnpm install` then crashes with
 *     ERR_UNKNOWN_BUILTIN_MODULE, node_modules never gets created, and
 *     `next dev` dies with "next: not found" (the stuck-preview /
 *     ERR_SPAWN_FAILED report). bun is often simply absent. Trying them
 *     first just burns the install budget on a command that can't succeed.
 *   - npm always ships with Node; a fresh `node_modules` builds cleanly
 *     from `package.json`, so ignoring a pnpm/bun lockfile is safe for an
 *     ephemeral preview install.
 *   - `--legacy-peer-deps` mirrors the lenient peer resolution those
 *     lockfiles assume; plain `npm install` ERESOLVE-fails on the React-19
 *     peer ranges v0 / Next.js templates ship.
 *
 * yarn.lock wins even when pnpm-lock.yaml is also present: a yarn-built
 * repo that later picked up a stray pnpm-lock should still install with
 * yarn (the caller installs yarn on demand if it's missing).
 *
 * Non-Node projects (no `package.json`) return null and let the
 * agent's `setup_commands` cover Python / Ruby / Go / Rust.
 */
export function detectMissingNodeDeps(
  cwd: string,
): { cmd: string; args: string[] } | null {
  if (!fs.existsSync(path.join(cwd, 'package.json'))) return null;
  if (fs.existsSync(path.join(cwd, 'node_modules'))) return null;
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) {
    return { cmd: 'yarn', args: ['install'] };
  }
  return { cmd: 'npm', args: ['install', '--legacy-peer-deps'] };
}

/**
 * Ensure `yarn` is runnable before a yarn-based install. A fresh GitHub
 * codespace ships node + npm only (`yarn: command not found`), so a yarn
 * project's pre-flight `yarn install` spawns ENOENT → "exit null" /
 * ERR_SPAWN_FAILED. Rather than fall back to npm (which would ignore the
 * project's real package manager + yarn.lock), we install yarn on demand.
 *
 * Pure + injectable for testing: the caller supplies `hasYarn` (a PATH probe)
 * and `installYarn` (the actual `npm install -g yarn` runner). Returns `ok`
 * when yarn is already present or became present after install; otherwise the
 * failure carries the installer's exit code so the caller can surface it.
 */
export async function ensureYarnInstalled(deps: {
  hasYarn: () => Promise<boolean>;
  installYarn: () => Promise<{ ok: boolean; code: number | null }>;
}): Promise<{ ok: boolean; code: number | null }> {
  if (await deps.hasYarn()) return { ok: true, code: 0 };
  const res = await deps.installYarn();
  if (!res.ok) return res;
  // The installer reported success — confirm yarn now resolves on PATH
  // (a global install can succeed yet land outside PATH on odd setups).
  return (await deps.hasYarn()) ? { ok: true, code: 0 } : { ok: false, code: res.code };
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
