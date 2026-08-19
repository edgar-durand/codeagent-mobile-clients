import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';

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

const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

/**
 * Locate the installed SDK's package directory through a require
 * resolver. The SDK's package.json declares an `exports` map that does
 * NOT expose `./package.json`, so `require.resolve('<sdk>/package.json')`
 * throws ERR_PACKAGE_PATH_NOT_EXPORTED on the real installed package —
 * the v2.52.8 bug that made the binary wait never resolve and burn the
 * codespace spawn gate's full 240 s on every start. Resolve the exported
 * MAIN instead and walk up to the package directory. Injectable resolver
 * so tests can drive REAL Node resolution against a temp layout.
 */
export function resolveSdkDirViaRequire(
  req: Pick<NodeJS.Require, 'resolve'> = require,
): string | null {
  // Preferred (works iff the SDK ever exports ./package.json).
  try {
    return path.dirname(req.resolve(`${SDK_PKG}/package.json`));
  } catch {
    /* exports map blocks it — fall through to the main-based walk */
  }
  try {
    let dir = path.dirname(req.resolve(SDK_PKG));
    // The main usually sits at the package root, but walk up defensively
    // (dist/ layouts) until the directory is the package itself.
    for (let i = 0; i < 5; i++) {
      if (path.basename(dir) === 'claude-agent-sdk') return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function defaultSdkDir(): string | null {
  return resolveSdkDirViaRequire();
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
  // The exe suffix belongs to the PLATFORM PACKAGE, not to the host process:
  // @anthropic-ai/claude-agent-sdk-win32-* ships `claude.exe`, every other
  // platform package ships `claude`. Derive it from the (injectable)
  // platformKey — with the default key (`${process.platform}-${process.arch}`)
  // this is byte-identical to checking process.platform, but it keeps the DI
  // seam coherent so tests can exercise any platform's layout on any OS
  // (deriving from ambient process.platform made every linux-x64 fixture
  // look for claude.exe on the Windows CI runners → null).
  const binName = platformKey.startsWith('win32-') ? 'claude.exe' : 'claude';
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

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Add well-known user-local npm bin directories to THIS process's PATH,
 * idempotently. Same stale-PATH class as kimi's `augmentKimiPath` /
 * opencode's `augmentOpencodePath` (`../kimi/installer.ts` /
 * `../opencode/installer.ts`), generalized to npm `-g`-installed agent
 * binaries (codex, gemini) instead of a single vendor-specific install dir.
 *
 * Root cause (fleet-1, 2026-08-14 — the SECOND bug behind that day's codex
 * switch failure, found after the half-finished-bin-link fix in
 * `switch-agent.ts` still didn't stick): the box runs `codeam host-agent`
 * as a **systemd unit** whose process PATH lacked `~/.local/bin` entirely.
 * `npm install -g @openai/codex` had actually landed the binary there (npm's
 * default global-prefix bin dir on a per-user install), but the bare
 * `waitForCommandOnPath('codex')` probe could never see it — so every
 * mention reported "installed but never appeared on PATH" and re-ran the
 * (already-successful) install, forever.
 *
 * Deliberately NOT a subprocess spawn (no `npm config get prefix` / `npm
 * prefix -g`) — every candidate is a static, well-known dir; a directory
 * that doesn't exist is a harmless PATH entry that never resolves, so this
 * stays cheap enough to call on every probe.
 *
 * Platform-agnostic by construction: every candidate is built with the
 * platform `path` (`pathApi`), and PATH is split/joined on that platform's
 * `delimiter` (`:` POSIX, `;` win32). The deps seam (same convention as
 * {@link CursorAgentResolveDeps}) exists so the win32 branch can be
 * unit-tested from any host via `path.win32` injection.
 */
export interface AugmentUserLocalBinPathsDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  pathApi?: path.PlatformPath;
}

export function augmentUserLocalBinPaths(deps: AugmentUserLocalBinPathsDeps = {}): void {
  const env = deps.env ?? process.env;
  const home = deps.homedir ?? os.homedir();
  const p = deps.pathApi ?? path;
  const candidates = [
    // XDG-style per-user bin — npm's default global-prefix bin dir on most
    // Linux setups (`npm config set prefix ~/.local` or an nvm-less
    // per-user npm), and where curl-based agent installers commonly land.
    p.join(home, '.local', 'bin'),
    // Common explicit npm global-prefix conventions seen in the wild
    // (`npm config set prefix ~/.npm-global`, and Debian/Fedora's
    // `~/.local/share/npm` layout for `npm config set prefix
    // ~/.local/share/npm`).
    p.join(home, '.npm-global', 'bin'),
    p.join(home, '.local', 'share', 'npm', 'bin'),
  ];
  const parts = (env.PATH ?? '').split(p.delimiter).filter((s) => s.length > 0);
  const existing = new Set(parts);
  const additions = candidates.filter((dir) => !existing.has(dir));
  if (additions.length === 0) return;
  env.PATH = [...additions, ...parts].join(p.delimiter);
}

// ─────────────────────────── cursor-agent ────────────────────────────
// cursor-agent is the odd one out: unlike codex/gemini (which land on the
// PATH we inherit), Cursor's installer updates PATH in a way a
// long-running process never sees — so we resolve it by absolute path.

/** Injectable deps for {@link resolveCursorAgentBinary} (test seams). */
export interface CursorAgentResolveDeps {
  existsSync?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

/**
 * Absolute path to the user-installed `cursor-agent` launch binary when
 * it can be found in its deterministic install location, else `null`
 * (caller falls back to bare-name PATH resolution).
 *
 * WHY this exists — the Windows stale-PATH trap:
 * Cursor's Windows installer (`cursor.com/install?win32=true`) unpacks the
 * binaries into `%LOCALAPPDATA%\cursor-agent\` and appends that dir to the
 * *User* PATH via `SetEnvironmentVariable(..., "User")`. That update never
 * reaches a process that is ALREADY running — and our CLI host is spawned
 * at pairing, before the user installs cursor-agent. So `cursor-agent` is
 * on disk but absent from the PATH we inherited, and a bare
 * `spawn('cursor-agent')` dies with `ENOENT` ("not found on PATH") even
 * though it is installed (Georgy, Win 11, 2026-07). Resolving the absolute
 * path sidesteps PATH entirely for the spawn.
 *
 * On macOS/Linux the installer drops it at `~/.local/bin/cursor-agent`
 * (normally already on PATH); we probe it too as a cheap fallback for the
 * same stale-env class, and return `null` when absent so the prior
 * PATH-resolution behavior still applies.
 */
export function resolveCursorAgentBinary(deps: CursorAgentResolveDeps = {}): string | null {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  // Build paths with the separator of the RESOLVED platform (not the host
  // running this code), so injecting `platform` is meaningful in tests and
  // production stays correct (`path.win32` on Windows, `path.posix` on Unix).
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) return null;
    // The installer copies `cursor-agent.exe` to the install root; the
    // `.exe` is the real launcher (`.cmd`/`.ps1` are shims that can't be
    // spawned without a shell), so we deliberately target the `.exe`.
    const exe = path.win32.join(localAppData, 'cursor-agent', 'cursor-agent.exe');
    return existsSync(exe) ? exe : null;
  }
  const home = deps.homedir ?? os.homedir();
  const unix = path.posix.join(home, '.local', 'bin', 'cursor-agent');
  return existsSync(unix) ? unix : null;
}

/**
 * Readiness gate for cursor-agent: ready once it resolves to an absolute
 * install path OR appears on PATH (a fresh install racing the spawn
 * gate). Mirrors {@link waitForCommandOnPath} but also honours the
 * known-location resolver, so the Windows stale-PATH case (installed but
 * off our PATH) is treated as ready instead of timing out for 180 s.
 */
export async function waitForCursorAgent(
  opts: WaitForCommandOptions & CursorAgentResolveDeps = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 500;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const check = (): boolean =>
    resolveCursorAgentBinary(opts) !== null || isCommandOnPath('cursor-agent', opts.probe);
  const deadline = now() + timeoutMs;
  if (check()) return true;
  while (now() < deadline) {
    await sleep(pollMs);
    if (check()) return true;
  }
  return check();
}

// ─────────────────── ACP adapter module-graph readiness ───────────────────
//
// The `waitForBinary` gate above covers the agent's LAUNCH BINARY (claude's
// native SDK dep, `codex`, …). It does NOT cover the ACP adapter's OWN bundled
// JavaScript dependency graph. On a fresh codespace the CLI + all agent deps
// install concurrently, and the adapter (`node <@agentclientprotocol/*-acp>`)
// can be spawned while its nested node_modules are still being written — a
// half-installed `zod` then makes `node <adapter>` crash at import with
// `ERR_MODULE_NOT_FOUND` / a truncated-file `SyntaxError`, surfacing to the
// user as "Agent adapter exited unexpectedly (code=1)" (2026-07-06 incident).
//
// This gate probes the adapter's module graph by actually loading it in a
// throwaway child and only releases the spawn once it resolves — so the code=1
// crash can never reach a real session.

/**
 * Import/parse errors that mean the adapter's node_modules is still settling
 * (a fresh/partial install), NOT a genuine, permanent failure. A SECONDARY
 * signal only — the PRIMARY classification is now STRUCTURAL (a healthy adapter
 * blocks on stdin and never exits, so an early non-zero exit = not-ready; see
 * {@link probeAdapterModuleGraph} and `AcpClient`'s start-retry). This regex is
 * the belt-and-suspenders fallback that still recognises the crash by its text.
 *
 * ⚠️ Enumerating error CODES was proven fragile — each fresh-codespace deploy
 * crashes on whichever package is mid-atomic-rename at that instant, with
 * whatever code that specific failure yields, so the list kept growing (2026-07:
 * `SyntaxError`(truncated sdk.mjs) → `ERR_MODULE_NOT_FOUND` → `ETXTBSY` →
 * `ERR_UNSUPPORTED_DIR_IMPORT` on `zod/v4`). The `node:internal/modules/` clause
 * is the real catch-all: ANY crash whose stack is inside Node's module resolver
 * during startup is an install race, regardless of the specific code — that
 * ends the whack-a-mole even for future variants. The explicit codes remain for
 * readability + logs that don't include the stack frame.
 */
export const ADAPTER_MODULE_LOAD_ERROR_RE =
  /ERR_MODULE_NOT_FOUND|Cannot find module|ERR_REQUIRE_ESM|ERR_UNKNOWN_BUILTIN_MODULE|ERR_UNSUPPORTED_DIR_IMPORT|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_INVALID_PACKAGE_CONFIG|ERR_INVALID_PACKAGE_TARGET|ERR_INVALID_MODULE_SPECIFIER|node:internal\/modules\/|Directory import|SyntaxError|Unexpected (token|end|identifier)|missing \) after argument list/i;

/**
 * Adapter stderr patterns that mean a PERMANENT startup failure (auth /
 * tier-ineligibility) — the ONE thing the structural "any early exit = retry"
 * gate must NOT loop on. Kept in sync with `client.ts` FATAL_STARTUP_RE (a small
 * duplication to avoid an import cycle: client.ts imports from THIS file). In
 * practice the probe never drives the adapter to `session/new`, so auth/tier
 * doesn't fire during a probe — this is defence-in-depth so a hypothetical
 * crash-at-load auth error can't be retried in a tight loop.
 */
const PERMANENT_ADAPTER_STARTUP_RE =
  /IneligibleTierError|UNSUPPORTED_CLIENT|no longer supported for Gemini Code Assist|not eligible for Gemini Code Assist|Error authenticating|ProjectIdRequiredError/i;

export type AdapterProbeResult = 'ok' | 'transient';

export interface ProbeAdapterOptions {
  /** How long the adapter must stay alive to be judged "modules loaded".
   *  A healthy adapter loads its graph then blocks reading the ACP handshake
   *  off stdin, so surviving this window means the graph resolved. Default 400ms. */
  livenessMs?: number;
  /** Injectable spawn (tests). Defaults to child_process.spawn. */
  spawnFn?: typeof spawn;
}

/**
 * Load the adapter's module graph in a throwaway child and classify the result:
 * - `transient` — it exited non-zero with an import/parse error (install still
 *   settling → worth retrying).
 * - `ok` — it survived the liveness window (graph loaded, now blocked on stdin),
 *   OR it exited for a NON-module reason (auth/tier/etc. — not our concern here;
 *   don't loop on those). We never block the spawn on non-install failures.
 */
export function probeAdapterModuleGraph(
  command: string,
  args: readonly string[],
  opts: ProbeAdapterOptions = {},
): Promise<AdapterProbeResult> {
  const livenessMs = opts.livenessMs ?? 400;
  const spawnFn = opts.spawnFn ?? spawn;
  return new Promise<AdapterProbeResult>((resolve) => {
    let settled = false;
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;
    const finish = (r: AdapterProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(r);
    };
    try {
      child = spawnFn(command, [...args], { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch {
      // Couldn't even spawn — not a module-graph issue; the real spawn path
      // surfaces its own actionable error. Don't loop.
      resolve('ok');
      return;
    }
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on('error', () => finish('ok'));
    child.on('exit', (code) => {
      // STRUCTURAL classification (not error-string matching): a healthy adapter
      // loads its whole module graph then BLOCKS reading the ACP handshake off
      // stdin — it does NOT exit inside the liveness window. So ANY early
      // non-zero exit means the graph isn't ready yet (some still-installing dep
      // crashed the import), whatever the specific Node error code. Treating it
      // as 'transient' makes the caller keep polling until the install settles —
      // and, unlike the old regex gate, it can never be defeated by a new,
      // unlisted error code (the ERR_UNSUPPORTED_DIR_IMPORT / zod-v4 miss). The
      // ONLY thing we must not loop on is a PERMANENT startup failure
      // (auth/tier); let that through as 'ok' so the real spawn surfaces the
      // actionable error instead of burning the whole gate timeout.
      if (code !== 0 && code !== null && !PERMANENT_ADAPTER_STARTUP_RE.test(stderr)) {
        finish('transient');
      } else {
        finish('ok');
      }
    });
    timer = setTimeout(() => finish('ok'), livenessMs);
  });
}

export interface WaitForAdapterOptions extends ProbeAdapterOptions {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll {@link probeAdapterModuleGraph} until the adapter's module graph loads
 * cleanly (returns `true`) or the timeout elapses (`false`, caller spawns anyway
 * — no worse than today, but the crash window is almost always short). Bounded
 * like the binary gate so a genuinely broken install can't wedge the session.
 */
export async function waitForAdapterModuleGraph(
  command: string,
  args: readonly string[],
  opts: WaitForAdapterOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 500;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const probeOpts: ProbeAdapterOptions = { livenessMs: opts.livenessMs, spawnFn: opts.spawnFn };
  const deadline = now() + timeoutMs;
  if ((await probeAdapterModuleGraph(command, args, probeOpts)) === 'ok') return true;
  while (now() < deadline) {
    await sleep(pollMs);
    if ((await probeAdapterModuleGraph(command, args, probeOpts)) === 'ok') return true;
  }
  return false;
}
