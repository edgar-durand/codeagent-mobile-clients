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
