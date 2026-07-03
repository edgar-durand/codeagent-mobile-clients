import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

/**
 * Agent launch-binary readiness.
 *
 * On a fresh codespace the CLI and every agent's binary are installed
 * concurrently (`npm install -g codeam-cli`, `npm install -g
 * @openai/codex`, the cursor/gemini installers, the SDK's optional
 * native binary…). The agent-spawn gate can release before a given
 * agent's binary finishes landing, so the spawn then dies with a
 * "binary not found" error. Each ACP adapter declares how to wait for
 * ITS binary (see adapters.ts `waitForBinary`) and the gate just calls
 * that — so this is fixed uniformly for claude / codex / cursor /
 * gemini, not just the one that happened to be reported.
 *
 * Two delivery shapes:
 *   - PATH binaries (codex, cursor-agent, gemini) → wait for the
 *     command to resolve on PATH ({@link waitForCommandOnPath}).
 *   - The Claude Agent SDK's ~250 MB native `claude` binary, a
 *     PLATFORM-SPECIFIC OPTIONAL dependency
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`). On a fresh
 * codespace the CLI is installed with `npm install -g codeam-cli`, and
 * that huge optional binary can still be downloading when the
 * agent-spawn gate releases — so the ACP adapter's `newSession` spawns
 * a binary that isn't on disk yet and the turn dies with:
 *
 *   "Claude native binary not found for linux-x64. Reinstall
 *    @anthropic-ai/claude-agent-sdk without --omit=optional …"
 *
 * (2026-07-03 incident: binary landed at 19:53:40, agent tried to start
 * at 19:53:15 — 25 s early.) This module lets the spawn gate WAIT for
 * the binary to finish installing, exactly like it already waits for
 * beads + project deps.
 *
 * Everything is dependency-injected so it can be exercised against a
 * real temp filesystem in tests (no fs mocks).
 */

export interface ClaudeBinaryDeps {
  /** Absolute path to the installed `@anthropic-ai/claude-agent-sdk`
   *  package dir. Defaults to resolving it from the CLI's own deps. */
  sdkDir?: string | null;
  /** Platform key that names the sibling binary package, e.g.
   *  `linux-x64`. Defaults to `${process.platform}-${process.arch}`. */
  platformKey?: string;
  /** Existence probe — injectable for tests. Defaults to fs.existsSync. */
  existsSync?: (p: string) => boolean;
}

/** `${process.platform}-${process.arch}` → e.g. `linux-x64`, `darwin-arm64`. */
export function currentPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function defaultSdkDir(): string | null {
  try {
    const manifest = require.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    return path.dirname(manifest);
  } catch {
    return null;
  }
}

/**
 * Absolute path to the Claude native binary if it's present on disk,
 * else null. The binary lives in a sibling package of the SDK:
 * `<@anthropic-ai>/claude-agent-sdk-<platformKey>/claude`.
 */
export function resolveClaudeNativeBinary(deps: ClaudeBinaryDeps = {}): string | null {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const platformKey = deps.platformKey ?? currentPlatformKey();
  const sdkDir = deps.sdkDir !== undefined ? deps.sdkDir : defaultSdkDir();
  if (!sdkDir) return null;
  // sdkDir = .../@anthropic-ai/claude-agent-sdk → sibling scope dir is its parent.
  const scopeDir = path.dirname(sdkDir);
  const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidate = path.join(scopeDir, `claude-agent-sdk-${platformKey}`, binName);
  return existsSync(candidate) ? candidate : null;
}

export interface WaitForClaudeBinaryOptions extends ClaudeBinaryDeps {
  /** Give up after this long. Default 180 s (a cold 250 MB pull). */
  timeoutMs?: number;
  /** Poll interval. Default 500 ms. */
  pollMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
  /** Injectable sleeper for tests. Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the Claude native binary appears on disk (it's still being
 * downloaded by `npm install -g codeam-cli`) or the timeout elapses.
 * Returns the resolved path, or null if it never showed up in time
 * (caller spawns anyway — no worse than today, and the SDK emits its
 * own actionable "reinstall" error).
 */
export async function waitForClaudeNativeBinary(
  opts: WaitForClaudeBinaryOptions = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 500;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const deps: ClaudeBinaryDeps = {
    sdkDir: opts.sdkDir,
    platformKey: opts.platformKey,
    existsSync: opts.existsSync,
  };
  const deadline = now() + timeoutMs;
  // Fast path: already there → return immediately, zero delay.
  let found = resolveClaudeNativeBinary(deps);
  if (found) return found;
  while (now() < deadline) {
    await sleep(pollMs);
    found = resolveClaudeNativeBinary(deps);
    if (found) return found;
  }
  return resolveClaudeNativeBinary(deps);
}

// ─────────────────────────── PATH binaries ───────────────────────────
// codex (`npm install -g @openai/codex`), cursor-agent, and gemini are
// launched by bare command name resolved from PATH — their readiness is
// simply "does the command resolve on PATH yet".

/** True if `cmd` resolves on the current PATH. Injectable for tests. */
export function isCommandOnPath(
  cmd: string,
  probe: (cmd: string) => boolean = defaultWhich,
): boolean {
  return probe(cmd);
}

function defaultWhich(cmd: string): boolean {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(finder, [cmd], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

export interface WaitForCommandOptions {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable PATH probe for tests. */
  probe?: (cmd: string) => boolean;
}

/**
 * Poll until `cmd` resolves on PATH (its installer — npm -g / vendor
 * script — is still running) or the timeout elapses. Returns true if it
 * showed up in time. Fast path: resolves immediately when already
 * present (zero delay on the happy path).
 */
export async function waitForCommandOnPath(
  cmd: string,
  opts: WaitForCommandOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 500;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const probe = opts.probe;
  const check = (): boolean => isCommandOnPath(cmd, probe);
  const deadline = now() + timeoutMs;
  if (check()) return true;
  while (now() < deadline) {
    await sleep(pollMs);
    if (check()) return true;
  }
  return check();
}
