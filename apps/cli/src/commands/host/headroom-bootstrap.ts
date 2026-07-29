// src/commands/host/headroom-bootstrap.ts
//
// Headroom setup for the self-hosted box: `setupHeadroomForSelfHosted`
// (pip install → model pre-download → `headroom init` → proxy warm-start),
// the bundled-claude PATH resolution the init step needs, the agent-id →
// headroom-kind thin wrappers, and the install disk preflight helpers.
// Moved VERBATIM out of host-agent.ts (Phase 3 refactor) — only the
// import/export wiring changed (and the proxy warm-start now goes through
// the shared `spawnHeadroomProxy`). host-agent.ts re-exports the surface.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  headroomKindFor,
  HEADROOM_EXTRAS_BY_SURFACE,
  HEADROOM_PIP_COMPANIONS,
  headroomPipPackage,
  headroomModelPredownloadScript,
  HEADROOM_MODELS,
} from '@codeam/shared';
import { log } from '../../services/logger';
import { spawnHeadroomProxy } from '../../services/headroom/proxy-process';
import {
  defaultHeadroomRunner,
  ensureModernPython,
  ensurePip,
  type HeadroomRunner,
} from './os-packages';
import { backupAgentHeadroomConfig } from './headroom-config';

/** PEP 668 "externally-managed-environment" signal string (Debian 12+, Ubuntu 24.04+). */
const PEP668_MARKER = 'externally-managed-environment';

/** Timeout for each `python3 -m pip install ...` attempt. */

/** Timeout for the heavier Headroom-engine installs (PyTorch + the ML/AST
 *  extras are large — several minutes on a cold box). */
const ENGINE_INSTALL_TIMEOUT_MS = 360_000;

/** Free disk Headroom's ONNX engines need (onnxruntime + transformers +
 *  tree-sitter + the ~840 MB Kompress model + pip temp ≈ 1.5 GB; 2 GB leaves
 *  headroom). Below this we skip the install and tell the user rather than
 *  fill the host's disk. ONNX is far lighter than the old torch path (>3 GB). */
export const HEADROOM_MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Map an incoming agent id (a `LinkedAgentId` like `claude_code`, `codex_cli`,
 * or an already-normalized `claude`) to the subcommand kind that `headroom init`
 * understands: `claude` | `codex` | `copilot`.
 *
 * `headroom init` only accepts those exact subcommands — passing the raw
 * LinkedAgentId (`claude_code`) makes it fail with "No such command", and an
 * empty id makes it print a usage error. This collapses the two id spaces.
 *
 * Match is case-insensitive and tolerant of `_`/`-` separators. Anything we
 * don't recognise (including empty/undefined) defaults to `claude` — the most
 * common path, and a safe default since a bad subcommand is worse than a guess.
 *
 * Thin wrapper over the shared registry-derived {@link headroomKindFor}
 * (`@codeam/shared`). The `claude` default lives HERE only: this function
 * picks the `headroom init` subcommand AFTER {@link isHeadroomSupportedAgent}
 * has gated the agent — the shared helper itself never falls back (a claude
 * fallback pre-gate is how the 2026-06 Cursor mislaunch happened).
 */
export function agentIdToHeadroomKind(agentId: string): string {
  return headroomKindFor(agentId) ?? 'claude';
}

/**
 * Whether Headroom can wrap this agent. The Headroom kind IS the agent
 * Headroom launches, so wrapping an UNSUPPORTED agent would mislaunch it as
 * the `agentIdToHeadroomKind` fallback (Claude). For unsupported agents Headroom
 * must be DISABLED so the agent runs natively.
 *
 * Supported = the agents `headroom wrap <kind>` actually LAUNCHES through the
 * proxy: claude, codex, copilot. NOT cursor — `headroom wrap cursor` is
 * "manual setup" (it only prints base-URLs for the Cursor IDE; the headless
 * cursor-agent CLI has no base-URL override, so Headroom can't route it). NOT
 * gemini. Those run natively (cursor additionally runs over ACP).
 *
 * Thin wrapper over the shared registry flags — supported ⇔ the registry
 * entry carries a `headroomKind` (see `@codeam/shared` `headroomKindFor`).
 */
export function isHeadroomSupportedAgent(agentId: string): boolean {
  return headroomKindFor(agentId) !== null;
}

/**
 * Progress step identifiers emitted by {@link setupHeadroomForSelfHosted}.
 * In order: pip install → model pre-download → headroom init → proxy spawn → done.
 */
export type HeadroomStep = 'pip' | 'model' | 'init' | 'proxy' | 'ready';

/**
 * Locate the directory holding the SDK-bundled `claude` binary, so it can be
 * prepended to `headroom init`'s PATH.
 *
 * `headroom init --global claude` (≥0.26) HARD-FAILS with "'claude' not found
 * in PATH. Install Claude Code first." when no `claude` is on PATH. On a
 * self-hosted box claude ships ONLY as the platform binary under
 * `@anthropic-ai/claude-agent-sdk-<platform>/claude` (the same binary the ACP
 * adapter spawns by absolute path) — never on PATH. We resolve that dir here
 * and inject it for the init call only; we never mutate the global PATH or
 * symlink, and the runtime hooks headroom writes invoke `headroom`, not
 * `claude`, so the child needs nothing extra. Returns null when not found
 * (init then fails gracefully, exactly as before).
 */
function bundledClaudeBinDir(): string | null {
  // Collect candidate node_modules roots by walking up from this module's dir
  // (the bundled dist lives at <cli-root>/dist, so <cli-root>/node_modules is
  // one hop up). We deliberately do NOT use
  // `require.resolve('@anthropic-ai/claude-agent-sdk/package.json')` — the
  // SDK's strict `exports` map blocks the ./package.json subpath and throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED (the v2.39.58 failure mode).
  const roots = new Set<string>();
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    roots.add(path.join(dir, 'node_modules'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Hoisting-proof fallback: derive the node_modules root from the SDK's MAIN
  // entry (its main IS exported, unlike ./package.json).
  try {
    const main = require.resolve('@anthropic-ai/claude-agent-sdk');
    const marker = `${path.sep}@anthropic-ai${path.sep}`;
    const idx = main.lastIndexOf(marker);
    if (idx !== -1) roots.add(main.slice(0, idx));
  } catch {
    /* ignore — the walk-up roots are the primary path */
  }

  for (const nm of roots) {
    const atAnthropic = path.join(nm, '@anthropic-ai');
    let entries: string[];
    try {
      entries = fs.readdirSync(atAnthropic);
    } catch {
      continue; // root doesn't exist / not readable
    }
    for (const entry of entries) {
      if (!entry.startsWith('claude-agent-sdk-')) continue; // platform package
      const bin = path.join(atAnthropic, entry, 'claude');
      if (fs.existsSync(bin)) return path.dirname(bin);
    }
  }
  return null;
}

/**
 * Free bytes on the filesystem backing `dir`, or null when it can't be
 * determined (statfs unavailable / errored). Callers treat null as "unknown —
 * don't block." Exported for testing. Node ≥ 20 provides `fs.promises.statfs`.
 */
export async function getFreeDiskBytes(dir: string): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(dir);
    return s.bsize * s.bavail;
  } catch {
    return null;
  }
}

/**
 * Set up Headroom on the self-hosted box so the pair-auto child's agent
 * routes through the local compression proxy and savings reach the dashboard.
 *
 * Steps (all best-effort — never throws, never blocks the deploy):
 *   0. Ensure pip is available. If neither `pip` nor `pip3` is on PATH, treat
 *      the box as bare and provision python3 + pip + ca-certificates + curl via
 *      the OS package manager (apt-get/apk/dnf/yum/pacman/zypper). Bounded at
 *      180s. Best-effort: if provisioning fails, returns false.
 *   0b. Resolve a Python interpreter ≥3.10. headroom-ai ships abi3 wheels tagged
 *      cp310, so Python 3.9 (e.g. macOS Xcode's default) has no matching wheel.
 *      Version-suffixed binaries (python3.13…python3.10) are probed newest-first;
 *      bare `python3` is accepted only when it is itself ≥3.10. If none is found,
 *      skips Headroom and warns (install python3.11+ via brew/apt).
 *   1. `<py> -m pip install --quiet` headroom-ai + companion packages.
 *      On PEP 668 "externally-managed-environment" error (Ubuntu 24.04+,
 *      Debian 12+), retries with `--break-system-packages`. 120s timeout.
 *   2. `headroom init --global <agent>` to write ~/.claude/settings.json.
 *   3. Warm-start `headroom proxy --port 8787` as a detached background process.
 *
 * Returns true when setup succeeded well enough to pass HEADROOM_* env to the
 * child (install + init both ok). Returns false on any failure — the caller
 * must NOT set HEADROOM_* env in that case so the child reporter no-ops.
 *
 * @param agent - e.g. 'claude', passed to `headroom init --global`.
 * @param runner - Injectable subprocess runner. Defaults to `defaultHeadroomRunner`.
 *                 Tests pass a mock so no real apt/pip runs.
 */
/**
 * True when Headroom's Kompress models are ALREADY warmed in the HF cache. The
 * codeam-box fleet image pre-downloads them into HF_HOME (/opt/hf-cache), so a
 * deploy on a baked box can skip the ~840 MB download entirely. Filesystem-only
 * (NO network): checks the canonical `<hub>/models--<org>--<repo>` dir for every
 * model in the shared manifest — the same cache layout `snapshot_download`
 * writes, so a hit here guarantees the runtime loader finds them offline.
 */
function headroomModelsCached(): boolean {
  const hubDir =
    process.env.HUGGINGFACE_HUB_CACHE ||
    path.join(
      process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'),
      'hub',
    );
  return HEADROOM_MODELS.every((m) =>
    fs.existsSync(path.join(hubDir, `models--${m.repo.replace('/', '--')}`)),
  );
}

export async function setupHeadroomForSelfHosted(
  agent: string,
  runner: HeadroomRunner = defaultHeadroomRunner,
  opts: {
    extras?: string[];
    onProgress?: (step: HeadroomStep) => void;
    /** Test seam — override the filesystem "models already warmed" probe. */
    modelsCached?: () => boolean;
  } = {},
): Promise<boolean> {
  const extras = opts.extras ?? [...HEADROOM_EXTRAS_BY_SURFACE.selfHosted];
  const onProgress = opts.onProgress ?? (() => {});
  // The proxy's HTTP/server deps (shared Headroom manifest). The COMPRESSION
  // ENGINES come from the headroom-ai extras below — NOT this list.
  const SERVER_DEPS = HEADROOM_PIP_COMPANIONS;

  // ── Step 0: Ensure pip is available ──────────────────────────────────────
  // Disk preflight lives in the deploy caller (it owns the app-feedback
  // channel) — see the headroom step in prepareAndSpawn.
  const pipAvailable = await ensurePip(runner);
  if (!pipAvailable) {
    return false;
  }

  // ── Step 0b: Resolve a Python ≥3.10 interpreter ─────────────────────────
  // headroom-ai ships abi3 wheels tagged cp310. The macOS default `python3` is
  // Xcode's Python 3.9.6 (pip 21.2.4), which has no matching wheel → pip errors
  // "Could not find a version that satisfies the requirement headroom-ai[...]
  // (from versions: none)" → install silently fails → Headroom skipped.
  // The same box typically has /opt/homebrew/bin/python3.13 where it installs
  // fine. We probe version-suffixed binaries newest-first so the best available
  // modern interpreter is used; bare `python3` is a last resort accepted only
  // when it is itself ≥3.10 (modern Linux distros are).
  // ensurePip runs BEFORE this resolver so a freshly-provisioned python3 on a
  // bare Linux box is in scope. When no ≥3.10 interpreter exists,
  // ensureModernPython AUTO-INSTALLS one (brew on macOS, the OS package manager
  // on Linux) and re-probes — we only skip when the install also fails to yield
  // a qualifying interpreter.
  const py = await ensureModernPython(runner);
  if (py === null) {
    log.warn(
      'host-agent',
      'Headroom needs Python ≥3.10 and auto-install failed (no brew on macOS / package manager couldn’t provide it) — skipping Headroom',
    );
    return false;
  }
  log.info('host-agent', `Headroom will use interpreter: ${py}`);

  // pip install with the PEP 668 "externally-managed-environment" retry
  // (Ubuntu 24.04+/Debian 12+). We use the resolved ≥3.10 interpreter explicitly
  // rather than bare `python3`, which can be an old system/Xcode 3.9 that has
  // no headroom-ai wheel. `<py> -m pip` resolves pip against the right interpreter.
  const pipInstall = async (
    pkgs: string[],
    extraArgs: string[],
    timeoutMs: number,
  ): Promise<boolean> => {
    const base = ['-m', 'pip', 'install', '--quiet', ...extraArgs, ...pkgs];
    const r = await runner.run(py, base, { timeoutMs });
    if (r.code === 0) return true;
    if (r.stderr.includes(PEP668_MARKER)) {
      const r2 = await runner.run(py, [...base, '--break-system-packages'], { timeoutMs });
      return r2.code === 0;
    }
    return false;
  };

  // ── Step 1: install Headroom WITH its compression engines (ONNX) ──────────
  // This is the whole point of Headroom and what we previously got wrong: the
  // engines that actually compress a coding agent's code+prose context are
  //   • Kompress — the trained ML compressor that delivers the real savings, and
  //   • CodeCompressor — AST-aware (the `[code]` extra → tree-sitter).
  // Installing bare `headroom-ai` (as we used to) leaves only the JSON
  // compressor, which finds nothing to do on coding traffic → ~0% saved.
  //
  // CRITICAL: Kompress runs on the ONNX Runtime, NOT PyTorch. The `[proxy]`
  // extra pulls onnxruntime + transformers (everything Kompress needs); we do
  // NOT install `[ml]`/torch. torch is multi-GB, disk-fragile, and a broken
  // torch makes the proxy HANG every request when Kompress lazy-loads it
  // (observed live: a torch corrupted by an ENOSPC install threw "torch has no
  // attribute 'library' — circular import", wedging every prompt at
  // "Thinking…"). ONNX is lighter (~1.5 GB total) and robust. All best-effort +
  // bounded: a box too small falls back to launching the agent direct.
  // ── Fast path: a PRE-BAKED box already ships headroom + the warmed model ──
  // The codeam-box fleet image installs headroom-ai and pre-downloads the
  // Kompress model into HF_HOME. When BOTH are already present we skip the pip
  // install AND the ~840 MB model download entirely — re-running them is a slow
  // no-op at best and a network round-trip / re-download at worst. This is what
  // makes pre-baking the image actually pay off: a deploy on a baked box goes
  // straight to `headroom init` + proxy warm-start. (Agents/beads/dolt already
  // skip-if-present via findInPath/which; this closes the gap for headroom.)
  const modelsCached = opts.modelsCached ?? headroomModelsCached;
  if (runner.which('headroom') !== null && modelsCached()) {
    log.info(
      'host-agent',
      'headroom + Kompress model already present (baked image) — skipping pip install + model download',
    );
    onProgress('pip');
    onProgress('model');
  } else {
    onProgress('pip');
    const headroomPkg = headroomPipPackage(extras);
    const installOk = await pipInstall([headroomPkg, ...SERVER_DEPS], [], ENGINE_INSTALL_TIMEOUT_MS);
    if (!installOk) {
      log.warn('host-agent', `headroom engine install failed (${headroomPkg}) — skipping Headroom`);
      return false;
    }
    log.info('host-agent', `headroom + ONNX engines installed (${headroomPkg})`);

    onProgress('model');
    // ── Step 1b: pre-download the Kompress model so the first prompt isn't slow ─
    // The proxy eager-preloads the model at startup with allow_download=False and
    // DEFERS the ~840 MB download to the FIRST prompt on a cache miss — that
    // deferred download blows the agent's 90s idle timeout → "Thinking…" forever
    // on message 1. Warming the cache here moves the download to setup time. Two
    // separate HF repos are required: kompress-v2-base (the ONNX model; skip its
    // .pt/.safetensors torch artifacts) and ModernBERT-base (TOKENIZER ONLY —
    // Kompress loads its tokenizer from there; skip its model weights). Best-
    // effort: a download failure leaves Kompress to lazy-load later. Repos +
    // allow_patterns come from the shared Headroom manifest (byte-identical to
    // the previous inline literal — guarded by the manifest test).
    const predownloadPy = headroomModelPredownloadScript();
    const dl = await runner.run(py, ['-c', predownloadPy], {
      timeoutMs: ENGINE_INSTALL_TIMEOUT_MS,
    });
    log.info(
      'host-agent',
      dl.code === 0
        ? 'Kompress model pre-downloaded — first prompt will be fast'
        : 'Kompress model pre-download failed (best-effort) — first prompt may be slow',
    );
  }

  // ── Step 2: `headroom init --global <agent>` (only when headroom is on PATH) ──
  // Verify headroom is on PATH before calling init; on some boxes pip installs
  // to a user-local directory that isn't on the current PATH yet.
  if (!runner.which('headroom')) {
    log.warn('host-agent', 'headroom not found on PATH after install — skipping init');
    return false;
  }
  // Map the incoming agent id (e.g. the LinkedAgentId `claude_code`) to the
  // subcommand kind `headroom init` accepts (`claude`/`codex`/`copilot`).
  const initKind = agentIdToHeadroomKind(agent);
  // Back up the agent's settings file before init overwrites it, so the user's
  // prior customisations can be restored later via restoreAgentHeadroomConfig.
  backupAgentHeadroomConfig(initKind);
  onProgress('init');
  // `headroom init --global claude` HARD-FAILS when no `claude` is on PATH.
  // On a self-hosted box claude is the SDK-bundled binary (never on PATH), so
  // prepend its dir to the init call's PATH. Init-call only — no global mutation.
  const initEnv = { ...process.env };
  if (initKind === 'claude') {
    const claudeDir = bundledClaudeBinDir();
    if (claudeDir) {
      initEnv.PATH = `${claudeDir}${path.delimiter}${process.env['PATH'] ?? ''}`;
      log.info('host-agent', `headroom init: bundled claude on PATH (${claudeDir})`);
    } else {
      log.warn('host-agent', 'headroom init: bundled claude binary not found — init may fail');
    }
  }
  const initResult = await runner.run('headroom', ['init', '--global', initKind], {
    env: initEnv,
  });
  const initOk = initResult.code === 0;
  if (!initOk) {
    const detail = initResult.stderr.replace(/\n+$/g, '');
    log.warn('host-agent', `headroom init failed (best-effort): ${detail}`);
  } else {
    const stdout = initResult.stdout ?? '';
    if (stdout.trim()) log.info('host-agent', `headroom init: ${stdout.trim()}`);
    log.info('host-agent', 'headroom init --global succeeded');
  }

  if (!initOk) {
    return false;
  }

  // ── Step 3: warm-start the proxy (detached, best-effort, don't await) ───
  // Pin Kompress to the ONNX CPU backend so it never tries to import torch
  // (absent by design). The proxy eager-preloads the pre-downloaded model from
  // cache at bind time, so the first prompt is compressed without a stall.
  onProgress('proxy');
  spawnHeadroomProxy(
    {
      tag: 'host-agent',
      spawnErrorMsg: (detail) => `headroom proxy warm-start error (best-effort): ${detail}`,
      failureMsg: (detail) => `headroom proxy warm-start failed (best-effort): ${detail}`,
    },
    // First deliberate warm-start of the deploy — take priority over any
    // supervisor tick racing it.
    { force: true },
  );

  onProgress('ready');
  return true;
}
