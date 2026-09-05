/**
 * Preview bring-up orchestrator — the staged pipeline behind the
 * `preview_start` command:
 *
 *   provisionDeps → startDevServer → establishTunnel → register + ready
 *
 * Extracted from the former ~640-line `previewStartH` body in
 * `commands/start/handlers.ts`. The handler keeps the relay/session
 * plumbing (HandlerContext, pluginAuthToken, fire-and-forget dispatch)
 * and passes ONE `emit(type, payload)` closure down here — this module
 * never touches the transport, so every stage is unit-testable with a
 * plain spy.
 *
 * All collaborators are called through the `previewSvc` namespace
 * import (same pattern as handlers.ts) so unit tests can intercept
 * them with module mocks / namespace spies under this repo's
 * esbuild/CJS transform.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import which from 'which';
import { USER_EVENTS, type PreviewDetection } from '@codeam/shared';
import { log } from '../logger';
import { killQuiet } from '../../lib/quiet';
import * as previewSvc from './index';
import { applyPreviewHostAllow } from './host-allow';
import { restoreProjectEnvIfMissing } from '../project-env';
import { resolveNamedTunnel } from './named-tunnel';
import { bringUpInspector } from './inspector-bringup';
import type { InspectorProxy } from './inspector-proxy';
import { fetchNamedPreviewTunnel } from '../pairing.service';

/**
 * Time budgets for the preview bring-up's blocking command steps
 * (BUG 1). Without these a stalled step — most commonly a fresh
 * codespace's `pnpm install` with no node_modules — wedges the whole
 * pipeline and the user waits on the spinner indefinitely.
 *
 * Installs get the generous budget (a cold monorepo install legitimately
 * runs into minutes); codegen / prebuild steps get the tighter one.
 */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const SETUP_TIMEOUT_MS = 2 * 60_000;

/** One deadline for BOTH tunnel flavours (named + quick). 45 s covers a
 *  cold launch (binary download, QUIC handshake). */
const TUNNEL_REGISTER_DEADLINE_MS = 45_000;

/** Every event type the bring-up pipeline emits. Subset of the
 *  `postPreviewEvent` union so the handler's closure typechecks. */
export type PreviewStartEventType =
  | typeof USER_EVENTS.PREVIEW_STARTING
  | typeof USER_EVENTS.PREVIEW_READY
  | typeof USER_EVENTS.PREVIEW_ERROR
  | typeof USER_EVENTS.PREVIEW_PROGRESS;

/**
 * The single fire-and-forget event emitter the orchestrator publishes
 * through — replaces the former scattered `void postPreviewEvent(…)`
 * call sites. Payloads/order are byte-identical to the pre-extraction
 * handler. Errors must be swallowed by the implementation: progress is
 * best-effort UX, not load-bearing.
 */
export type EmitPreviewEvent = (
  type: PreviewStartEventType,
  payload: Record<string, unknown>,
) => void;

export interface PreviewStartArgs {
  sessionId: string;
  detection: PreviewDetection;
  cwd: string;
  emit: EmitPreviewEvent;
  /**
   * Optional plugin auth for the per-repo `.env` vault restore. When present,
   * the provisionDeps stage restores a previously-saved `.env` for this repo
   * (if the working copy has none) before the dev server spawns. Omitted →
   * restore is skipped (older/unauthed callers, tests).
   */
  projectEnvAuth?: { pluginId: string; pluginAuthToken?: string };
}

/** Internal per-run context threaded through the stages. */
interface StageCtx extends PreviewStartArgs {
  /**
   * Realtime milestone emitter — one per step the dev-server bring-up
   * traverses (ENV_DETECTED → SETUP_RUN → BOOT_SEQUENCE → BIND_PORT →
   * WAITING_FOR_READY → READY_DETECTED → TUNNEL_STARTING →
   * TUNNEL_READY). The mobile + landing `PreviewStartingLog` subscribes
   * to these on the per-user SSE bus and renders the HANDSHAKE_LOG card.
   */
  emitProgress: (step: string, message: string) => void;
}

/**
 * Compile the agent's `ready_pattern` into a RegExp the spawn
 * watcher uses to detect "the dev server is up". Case-insensitive
 * on purpose: the detection prompt often produces lowercase patterns
 * like `"ready in"` while Next.js prints `Ready in` (capital R) and
 * Vite prints `ready in` (lowercase). A case mismatch is invisible
 * to the user, stalls the entire pipeline at WAITING_FOR_READY, and
 * surfaces as `ERR_READY_TIMEOUT` 120 s later. Most ready strings
 * are unambiguous enough that the looser match never
 * false-positives in practice.
 */
export function compileReadyPattern(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

export type ReadyOutcome =
  { kind: 'ready' } | { kind: 'exited'; code: number | null } | { kind: 'timeout' };

/** Minimal child-process surface `waitForDevServerReady` reads. Keeps
 *  the helper testable with a real `child_process.spawn` result OR a
 *  hand-rolled stub. */
export interface ChildProcessWithIO {
  readonly exitCode: number | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
}

/**
 * Watch a freshly-spawned dev server's stdout+stderr for the
 * compiled `ready_pattern` regex. Resolves with the outcome instead
 * of throwing so the caller can map each terminal state to the
 * right `preview_error` payload without a try/catch.
 *
 * Slides a 32 KB window over recent output so a ready signal split
 * across multiple `data` chunks ("Read" + "y in 1.5s") still
 * matches. Cap keeps memory bounded; the real ready line always
 * lands within the first few seconds of output, well under it.
 *
 * Polls `exitCode` every 250 ms because the `'exit'` event fires
 * once and we need to bail mid-loop without racing — same cadence
 * the inline implementation used.
 *
 * NOTE the `data` listeners deliberately stay attached after this
 * resolves: `opts.onChunk` keeps feeding the caller's output tail and
 * the Expo-URL parser during the post-ready tunnel stage.
 */
export async function waitForDevServerReady(
  devServer: ChildProcessWithIO,
  readyRe: RegExp,
  opts: {
    timeoutMs: number;
    onChunk?: (chunk: string) => void;
    /**
     * Additive readiness fallback (BUG 1). The `readyRe` regex is the
     * PRIMARY signal; this probe only catches the cases it misses — a
     * server that's actually listening on its port but whose stdout
     * never trips the agent-supplied pattern (e.g. Next.js's
     * `▲ Next.js 14.x` / `- Local: http://...` lines). Resolve `true`
     * once the port is accepting connections. Polled in the same loop
     * as the regex; whichever fires first wins. Omit it (non-Next.js
     * frameworks where the regex is reliable) to keep the legacy
     * stdout-only behavior.
     */
    portProbe?: () => Promise<boolean>;
  } = {
    timeoutMs: 120_000,
  },
): Promise<ReadyOutcome> {
  let readyMatched = false;
  const READY_BUFFER_MAX = 32_768;
  let readyBuffer = '';
  const consume = (chunk: Buffer): void => {
    const s = chunk.toString();
    opts.onChunk?.(s);
    if (readyMatched) return;
    readyBuffer += s;
    if (readyBuffer.length > READY_BUFFER_MAX) {
      readyBuffer = readyBuffer.slice(-READY_BUFFER_MAX);
    }
    if (readyRe.test(readyBuffer)) readyMatched = true;
  };
  devServer.stdout?.on('data', consume);
  devServer.stderr?.on('data', consume);

  // Guard against overlapping probe calls when one connect attempt
  // outlasts the 250 ms poll tick.
  let probeInFlight = false;
  const deadline = Date.now() + opts.timeoutMs;
  while (!readyMatched && Date.now() < deadline) {
    if (devServer.exitCode !== null) {
      return { kind: 'exited', code: devServer.exitCode };
    }
    if (opts.portProbe && !probeInFlight) {
      probeInFlight = true;
      void opts
        .portProbe()
        .then((up) => {
          if (up) readyMatched = true;
        })
        .catch(() => {
          /* probe failures are non-fatal — the regex / deadline still apply */
        })
        .finally(() => {
          probeInFlight = false;
        });
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (readyMatched) return { kind: 'ready' };
  return { kind: 'timeout' };
}

/**
 * `npx <binary>` is unreliable as a long-running spawn target. npm 11's
 * `npm exec` (the npx wrapper) fork-spawns the resolved binary and the
 * parent process can exit before the child is fully wired up — leaving
 * the dev server alive but orphaned (PPID 1) while the CLI's
 * `spawn(...)` handle reports `exitCode = 0` and bails out as if the
 * server crashed.
 *
 * Symptom: Mobile/landing's Preview card shows
 * `ERR_SPAWN_FAILED · Dev server exited (code 0)` even though
 * `ss -ltnp` confirms the port is bound and `curl` succeeds.
 *
 * Fix: when the agent returns `command: 'npx', args: [<bin>, …]` and
 * `./node_modules/.bin/<bin>` exists, rewrite the spawn target to the
 * direct binary path. Deterministic, no shell intermediate, no
 * lifecycle race. Falls through unchanged for npx-installed-on-demand
 * scenarios (binary not local), preserving the existing behavior for
 * tools like `cloudflared` that legitimately need npx.
 */
export function normalizeDetectionForSpawn(
  detection: PreviewDetection,
  cwd: string,
): PreviewDetection {
  // pnpm/bun can't run the dev server on the codespace runtime: pnpm ≥10
  // needs Node ≥22.13 (it imports node:sqlite) while codespaces ship Node 20,
  // and bun is often absent. The agent detection / saved `.codeam/preview.json`
  // may still carry `pnpm dev` (verified live: BOOT_SEQUENCE "pnpm dev" hung,
  // then ERR_SPAWN_FAILED). Rewrite the script run to npm — it always ships
  // with Node and reads the same package.json scripts. yarn is left alone
  // (yarn classic runs on Node 20). Only script runs are rewritten; one-off
  // binary fetches (`exec`/`dlx`/`x`) fall through unchanged.
  if (detection.command === 'pnpm' || detection.command === 'bun') {
    const raw = detection.args ?? [];
    const verb = raw[0];
    if (verb && !['exec', 'dlx', 'x'].includes(verb)) {
      const rest = verb === 'run' ? raw.slice(1) : raw;
      const [script, ...extra] = rest;
      if (script && !script.startsWith('-')) {
        // npm needs an explicit `--` before flags forwarded to the script;
        // pnpm/bun forward trailing args to the script implicitly.
        return {
          ...detection,
          command: 'npm',
          args: extra.length ? ['run', script, '--', ...extra] : ['run', script],
        };
      }
    }
  }
  if (detection.command !== 'npx') return detection;
  const args = detection.args ?? [];
  if (args.length === 0) return detection;
  const binName = args[0];
  if (binName.startsWith('-')) return detection;
  const binPath = path.join(cwd, 'node_modules', '.bin', binName);
  if (!fs.existsSync(binPath)) return detection;
  return {
    ...detection,
    command: binPath,
    args: args.slice(1),
  };
}

/**
 * Run the full preview bring-up for one `preview_start` (or restart).
 * Resolves when the pipeline reaches a terminal state — `preview_ready`
 * or a `preview_error` — every terminal state is announced through
 * `args.emit` before this resolves. Rejections are NOT handled here:
 * the caller owns the safety-net `preview_error` for unexpected throws.
 */
export async function runPreviewStart(args: PreviewStartArgs): Promise<void> {
  const { sessionId, detection, emit } = args;
  const ctx: StageCtx = {
    ...args,
    emitProgress: (step, message) => {
      emit(USER_EVENTS.PREVIEW_PROGRESS, { step, message, timestamp: Date.now() });
    },
  };

  // Reuse guard: if a dev server for this session is already running,
  // re-opening the preview must NOT re-spawn it on the same port
  // (that hits EADDRINUSE → ERR_SPAWN_FAILED "Port N already in use").
  const existing = previewSvc.activePreviews.get(sessionId);
  // Un preview adoptado (`devServer === null`) está vivo por definición: solo
  // se adopta lo que está sirviendo.
  if (existing && existing.devServer?.exitCode !== 0 && existing.devServer?.exitCode == null) {
    log.info('preview', `reusing running preview for session=${sessionId} url=${existing.url}`);
    ctx.emitProgress('READY_DETECTED', 'reusing running preview');
    emit(USER_EVENTS.PREVIEW_READY, {
      url: existing.url,
      framework: existing.framework,
      port: detection.port,
    });
    return;
  }

  emit(USER_EVENTS.PREVIEW_STARTING, {
    framework: detection.framework,
    port: detection.port,
  });
  ctx.emitProgress('ENV_DETECTED', `${detection.framework}`);

  if (!(await provisionDeps(ctx))) return;

  const dev = await startDevServer(ctx);
  if (!dev) return;

  const tun = await establishTunnel(ctx, dev);
  if (!tun) return;

  // Register + announce.
  ctx.emitProgress('TUNNEL_READY', tun.url);
  previewSvc.registerPreview(sessionId, {
    sessionId,
    devServer: dev.devServer,
    tunnel: tun.tunnel,
    inspector: tun.inspector,
    url: tun.url,
    framework: detection.framework,
    detection,
    cwd: ctx.cwd,
  });
  // Persist port ownership so a FRESH CLI (after a relay restart / hard-kill
  // that orphaned this dev server) can reclaim it instead of dead-ending on
  // "port already in use" (Rafael 2026-07-14). Best-effort; the in-memory
  // registry above is still the primary record for the live process.
  // Un adoptado no se registra como puerto NUESTRO: el registro existe para
  // poder reclamar un huérfano propio, y matar el servidor del usuario en un
  // arranque posterior sería exactamente el daño que se está evitando.
  if (dev.devServer) {
    previewSvc.recordPreviewPort(detection.port, dev.devServer.pid, sessionId, Date.now());
  }
  log.info('preview', `ready: ${detection.framework} at ${tun.url}`);
  emit(USER_EVENTS.PREVIEW_READY, {
    url: tun.url,
    framework: detection.framework,
    port: detection.port,
  });
}

/**
 * Stage 1 — dependency provisioning. The lockfile-aware Node-deps
 * pre-flight plus the agent's `setup_commands` (with the double-install
 * guard). Returns `false` when the pipeline must stop — the failure
 * `preview_error` has already been emitted.
 */
async function provisionDeps(ctx: StageCtx): Promise<boolean> {
  const { detection, cwd, emit, emitProgress } = ctx;

  // 0a. Reusable per-repo `.env`: on a fresh session of a repo we've stored a
  //     `.env` for, restore it BEFORE the dev server (and before ensureEnvFile
  //     generates a fresh one). Never overwrites a `.env` already on disk. Only
  //     runs when the caller passed plugin auth. Best-effort — never blocks.
  if (ctx.projectEnvAuth?.pluginAuthToken) {
    await restoreProjectEnvIfMissing(cwd, {
      sessionId: ctx.sessionId,
      pluginId: ctx.projectEnvAuth.pluginId,
      pluginAuthToken: ctx.projectEnvAuth.pluginAuthToken,
    });
  }

  // 0. Pre-flight: install Node deps if `package.json` exists but
  //    `node_modules/` is missing. Safety net for when the agent's
  //    `setup_commands` doesn't include an install — the dev server
  //    would otherwise crash on first spawn with "Cannot find
  //    module …". Returns null (no-op) when deps already present;
  //    we trust an existing `node_modules/` rather than running a
  //    slow no-op install on every preview boot.
  // Expo with a tunnel needs @expo/ngrok, or Expo halts on an interactive
  // "install it globally?" prompt (exit 1 under our non-TTY spawn). The box
  // image bakes it; this is the net for boxes/codespaces/locals that predate
  // that bake. Runs AFTER node_modules exist (below) when they are missing,
  // so the project-local install lands in a populated tree.
  const needsExpoNgrok = previewSvc.isExpoTunnelCommand(detection.command, detection.args ?? []);
  const missingDeps = previewSvc.detectMissingNodeDeps(cwd);
  let preflightRan = false;
  if (missingDeps) {
    // yarn isn't guaranteed on a fresh GitHub codespace (node + npm only).
    // If the project uses yarn, install it on demand FIRST — otherwise the
    // pre-flight spawns `yarn install` → ENOENT → exit null →
    // ERR_SPAWN_FAILED "Dependency install failed (yarn install, exit null)"
    // (observed live on a yarn project). We install rather than fall back to
    // npm so the project's real package manager + yarn.lock are honoured.
    if (missingDeps.cmd === 'yarn') {
      const ensured = await previewSvc.ensureYarnInstalled({
        hasYarn: async () => Boolean(await which('yarn', { nothrow: true })),
        installYarn: async () => {
          emitProgress('SETUP_RUN', 'installing yarn (not found on PATH) — npm install -g yarn');
          const r = await previewSvc.runSetupCommand(
            'npm',
            ['install', '-g', 'yarn'],
            cwd,
            detection.env,
            { timeoutMs: INSTALL_TIMEOUT_MS },
          );
          return { ok: r.status === 'ok', code: r.code };
        },
      });
      if (!ensured.ok) {
        emit(USER_EVENTS.PREVIEW_ERROR, {
          stage: 'spawn',
          message: `This project uses yarn but yarn isn't installed, and installing it automatically failed (npm install -g yarn, exit ${ensured.code}). Install yarn in this environment and try the preview again.`,
        });
        return false;
      }
    }
    emitProgress(
      'SETUP_RUN',
      `${missingDeps.cmd} ${missingDeps.args.join(' ')} (pre-flight — node_modules missing)`,
    );
    const result = await previewSvc.runSetupCommand(
      missingDeps.cmd,
      missingDeps.args,
      cwd,
      detection.env,
      { timeoutMs: INSTALL_TIMEOUT_MS },
    );
    if (result.status === 'timeout') {
      // The hang BUG 1 guards against: a fresh codespace with no
      // node_modules stalls the install → the dev server never
      // spawns → the user waits on the spinner forever. Bound it and
      // emit an error so mobile leaves the spinner.
      emit(USER_EVENTS.PREVIEW_ERROR, {
        stage: 'ready_timeout',
        message: `Dependency install (${missingDeps.cmd} ${missingDeps.args.join(' ')}) didn't finish within ${Math.round(INSTALL_TIMEOUT_MS / 1000)}s and was stopped. Run it manually in this project, then try the preview again.`,
      });
      return false;
    }
    if (result.status === 'failed') {
      emit(USER_EVENTS.PREVIEW_ERROR, {
        stage: 'spawn',
        message: `Dependency install failed (${missingDeps.cmd} ${missingDeps.args.join(' ')}, exit ${result.code}). Run it manually in this project and try again.`,
      });
      return false;
    }
    preflightRan = true;
  }

  if (needsExpoNgrok) {
    const ensured = await previewSvc.ensureExpoTunnelDeps({
      hasNgrok: async () => previewSvc.ngrokResolvesFrom(cwd),
      installNgrok: async () => {
        emitProgress(
          'SETUP_RUN',
          `npm install --no-save ${previewSvc.EXPO_NGROK_SPEC} (Expo tunnel needs ngrok; not found)`,
        );
        const r = await previewSvc.runSetupCommand(
          'npm',
          ['install', '--no-save', '--no-audit', '--no-fund', previewSvc.EXPO_NGROK_SPEC],
          cwd,
          detection.env,
          { timeoutMs: INSTALL_TIMEOUT_MS },
        );
        return { ok: r.status === 'ok', code: r.code };
      },
    });
    if (!ensured.ok) {
      emit(USER_EVENTS.PREVIEW_ERROR, {
        stage: 'spawn',
        message: `Expo's tunnel needs @expo/ngrok and installing it automatically failed (npm install --no-save ${previewSvc.EXPO_NGROK_SPEC}, exit ${ensured.code}). Install it in the project and try the preview again.`,
      });
      return false;
    }
  }

  // 1. Setup commands from the agent — but skip any install command
  //    when the pre-flight just installed deps. The agent
  //    occasionally emits `npm install` for a pnpm-lock project (or
  //    vice versa) and running a second install with a different
  //    package manager on top of a just-populated `node_modules/`
  //    crashes — pnpm's `.pnpm/` symlinked layout breaks npm's tree
  //    resolver and npm errors out after ~3 min of ERESOLVE warnings
  //    (observed in prod with `Cannot read properties of null
  //    (reading 'matches')`). Lockfile-based pre-flight detection is
  //    authoritative — the agent's install is at best redundant, at
  //    worst destructive. Non-install setup steps (`prisma generate`,
  //    `prebuild`, etc.) still run.
  // The agent emits setup_commands as either {cmd,args} objects OR bare
  // strings ("npx prisma generate") — the detection prompt's example never
  // pinned the entry shape, so both occur in the wild. Normalize to {cmd,args}
  // here so the loop below never does `undefined.join(...)` on a string entry,
  // which threw inside the detached bring-up → unhandled rejection → a SILENT
  // black-screen preview (observed live on a Prisma/Next.js project whose
  // setup_commands was ["npx prisma generate"]).
  const normalizedSetup = ((detection.setup_commands ?? []) as Array<unknown>)
    .map((entry) => {
      if (typeof entry === 'string') {
        const parts = entry.trim().split(/\s+/).filter(Boolean);
        return { cmd: parts[0] ?? '', args: parts.slice(1) };
      }
      const o = (entry ?? {}) as { cmd?: unknown; args?: unknown };
      return {
        cmd: typeof o.cmd === 'string' ? o.cmd : '',
        args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string') : [],
      };
    })
    .filter((s) => s.cmd.length > 0);
  const agentSetupCommands = preflightRan
    ? normalizedSetup.filter((s) => !previewSvc.isJsInstallCommand(s.cmd, s.args))
    : normalizedSetup;
  for (const setup of agentSetupCommands) {
    emitProgress('SETUP_RUN', `${setup.cmd} ${setup.args.join(' ')}`);
    // An install command (the agent may emit one for a project the
    // pre-flight didn't cover) gets the generous install budget; a
    // codegen/prebuild step gets the tighter one.
    const timeoutMs = previewSvc.isJsInstallCommand(setup.cmd, setup.args)
      ? INSTALL_TIMEOUT_MS
      : SETUP_TIMEOUT_MS;
    const result = await previewSvc.runSetupCommand(setup.cmd, setup.args, cwd, detection.env, {
      timeoutMs,
    });
    if (result.status === 'timeout') {
      emit(USER_EVENTS.PREVIEW_ERROR, {
        stage: 'ready_timeout',
        message: `Setup step (${setup.cmd} ${setup.args.join(' ')}) didn't finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`,
      });
      return false;
    }
    if (result.status === 'failed') {
      emit(USER_EVENTS.PREVIEW_ERROR, {
        stage: 'spawn',
        message: `Setup failed (${setup.cmd} ${setup.args.join(' ')}, exit ${result.code}).`,
      });
      return false;
    }
  }
  return true;
}

/** What stage 2 hands to stage 3. */
interface DevServerUp {
  /** `null` = adoptado: ya estaba corriendo y no lo arrancamos nosotros. */
  devServer: ReturnType<typeof spawn> | null;
  /**
   * Live ref — the readiness watcher's `data` listener stays attached
   * and keeps updating this after ready, so the Expo tunnel stage can
   * pick up a URL that lands late.
   */
  expoUrlRef: { current: string | null };
}

/**
 * Stage 2 — port guard + dev-server spawn + readiness. Returns `null`
 * when the pipeline must stop (terminal event already emitted — which,
 * on the port-race path, is a `preview_ready` reuse, not an error).
 */
async function startDevServer(ctx: StageCtx): Promise<DevServerUp | null> {
  const { sessionId, detection, cwd, emit, emitProgress } = ctx;

  // 2. Spawn the dev server.
  //    Rewrite `npx <bin>` to the direct binary path NOW (after
  //    the optional pre-flight install) — `node_modules/.bin/<bin>`
  //    is guaranteed to exist by this point if it's going to exist
  //    at all. See `normalizeDetectionForSpawn` for why bypassing
  //    npx matters: npm 11's `npm exec` fork-exec's the underlying
  //    binary and the parent dies with exitCode=0 while the child
  //    runs orphaned, fooling the spawn watcher into bailing
  //    immediately with ERR_SPAWN_FAILED.
  // Guard: the detected port must be FREE before we spawn. If something is
  // already listening on it (a stale process, another dev server, a leftover
  // from a prior run), our dev server can't bind it AND — worse — the tunnel
  // forwards to that squatter, serving someone else's content under the
  // preview URL (observed live: a leftover `http.server` on :3000 served a
  // /tmp directory listing through the tunnel). Fail fast with an actionable
  // error instead of tunnelling the wrong process.
  if (await previewSvc.isPortListening(detection.port)) {
    // Race-condition safety: if the port is already ours (a live devServer
    // registered in activePreviews for this session), treat it as a reuse
    // rather than an error — a second preview_start arrived while our server
    // was already up (or the top-of-run guard above was bypassed because
    // exitCode had already been set by the time we checked it).
    const raceExisting = previewSvc.activePreviews.get(sessionId);
    if (raceExisting && raceExisting.devServer?.exitCode == null) {
      log.info(
        'preview',
        `port race: reusing running preview for session=${sessionId} url=${raceExisting.url}`,
      );
      emitProgress('READY_DETECTED', 'reusing running preview');
      emit(USER_EVENTS.PREVIEW_READY, {
        url: raceExisting.url,
        framework: raceExisting.framework,
        port: detection.port,
      });
      return null;
    }
    // The port is held by OUR OWN prior preview for this session whose
    // parent process has already exited (exitCode !== null) but whose
    // worker children are still bound to the port (orphaned). This is the
    // "re-spawn on a port the same process already holds" case: reclaim it
    // — group-kill the stale tree, drop the registry entry, and wait
    // (bounded) for the port to actually release — then fall through and
    // re-spawn cleanly instead of failing with EADDRINUSE.
    if (raceExisting) {
      log.info(
        'preview',
        `reclaiming stale preview holding port ${detection.port} for session=${sessionId} (exit=${raceExisting.devServer?.exitCode})`,
      );
      await previewSvc.killPreview(sessionId);
      const freeDeadline = Date.now() + 4_000;
      while ((await previewSvc.isPortListening(detection.port)) && Date.now() < freeDeadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (await previewSvc.isPortListening(detection.port)) {
        // Our own teardown didn't free it in time — surface the actionable
        // error rather than spawn into a guaranteed EADDRINUSE.
        emit(USER_EVENTS.PREVIEW_ERROR, {
          stage: 'spawn',
          message: `Port ${detection.port} is still in use after stopping the previous preview. Wait a moment and try again.`,
        });
        return null;
      }
      // Port freed — continue to the spawn below.
    } else if (previewSvc.reclaimOwnOrphanPort(detection.port)) {
      // Not in THIS process's in-memory registry, but the persistent registry
      // says this port is OUR dev server orphaned by a prior CLI (relay
      // restart / hard-kill). We just SIGTERM'd our own group — wait (bounded)
      // for the OS to release the port, then fall through and re-spawn.
      // Rafael's exact complaint: reopening the app → "el puerto ya está
      // siendo usado" → had to ask the agent to close it. Now it self-heals.
      log.info('preview', `reclaimed own cross-restart orphan on port ${detection.port}`);
      const freeDeadline = Date.now() + 4_000;
      while ((await previewSvc.isPortListening(detection.port)) && Date.now() < freeDeadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (await previewSvc.isPortListening(detection.port)) {
        emit(USER_EVENTS.PREVIEW_ERROR, {
          stage: 'spawn',
          message: `Port ${detection.port} is still in use after stopping the previous preview. Wait a moment and try again.`,
        });
        return null;
      }
      // Port freed — continue to the spawn below.
    } else {
      /**
       * Algo que no hemos registrado como nuestro tiene el puerto.
       *
       * ⚠️ Antes esto era un callejón sin salida: «Port N is already in use by
       * another process. Stop whatever is listening…». Esa rama asumía
       * «ajeno», y el caso MUCHO más frecuente es el contrario — el dev server
       * del propio proyecto, arrancado por el agente o a mano en una terminal.
       * Eso no es ajeno: es exactamente lo que se quiere previsualizar. Un
       * usuario se quedó atascado ahí (replay de PostHog, 2026-08-29).
       *
       * Así que se le PREGUNTA al puerto qué sirve. Si es una app, se adopta y
       * se tunela. Si es un listado de directorios —el `http.server` olvidado
       * en `:3000` que motivó el error original— o cualquier otra cosa, se
       * falla como antes: tunelar eso publicaría los ficheros del usuario
       * creyendo que es su app.
       */
      const verdict = await previewSvc.canAdoptPort(detection.port);
      if (verdict.adopt) {
        log.info('preview', `adopting the dev server already serving on port ${detection.port}`);
        emitProgress('READY_DETECTED', `adopted the server already on port ${detection.port}`);
        // `devServer: null` = adoptado. No es nuestro, así que parar el
        // preview no lo mata.
        return { devServer: null, expoUrlRef: { current: null } };
      }

      emit(USER_EVENTS.PREVIEW_ERROR, {
        stage: 'spawn',
        message:
          verdict.reason === 'directory-listing'
            ? `Port ${detection.port} is serving a directory listing, not your app — that's usually a leftover \`python -m http.server\`. Stop it and try the preview again.`
            : `Port ${detection.port} is already in use by something that isn't a dev server, so the preview can't start there. Stop whatever is listening on port ${detection.port} and try again.`,
      });
      return null;
    }
  }

  // Make the framework's dev server trust our Cloudflare tunnel domains
  // (Next `allowedDevOrigins` / Vite `server.allowedHosts`) BEFORE it spawns —
  // otherwise a login/API request from the public tunnel URL is rejected as a
  // cross-origin dev request (Rafael, 2026-08-04). Best-effort + crash-safe:
  // the user's config is moved aside, never mutated, and restored on teardown.
  await applyPreviewHostAllow(cwd);

  const spawnable = normalizeDetectionForSpawn(detection, cwd);
  emitProgress('BOOT_SEQUENCE', `${spawnable.command} ${spawnable.args.join(' ')}`);
  // Expo tunnel: without a TTY Expo never prints its `exp://` URL (that line
  // is the interactive UI's). The ngrok debug channel does — opt into it so
  // the URL is observable. See `parseExpoUrl` / `expoTunnelDebugEnv`.
  const isExpo = detection.framework === 'Expo';
  const expoDebugEnv =
    isExpo && previewSvc.isExpoTunnelCommand(detection.command, detection.args ?? [])
      ? previewSvc.expoTunnelDebugEnv(spawnable.env?.DEBUG ?? process.env.DEBUG)
      : {};
  const devServer = spawn(spawnable.command, spawnable.args, {
    cwd,
    env: { ...process.env, ...(spawnable.env ?? {}), ...expoDebugEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX: lead a new process group so teardown can SIGTERM the whole
    // tree. Dev servers fork worker children that bind the port; killing
    // only the direct child orphans them and leaks the port, so the next
    // preview_start hits EADDRINUSE on a port we already hold. Group-kill
    // (killProcessTree) reaps the workers too. Windows has no process
    // groups — leave detached off there (direct kill is the only option).
    detached: process.platform !== 'win32',
  });
  emitProgress('BIND_PORT', String(detection.port));
  emitProgress('WAITING_FOR_READY', detection.ready_pattern);
  const expoUrlRef: DevServerUp['expoUrlRef'] = { current: null };
  // Bounded tail of the dev server's stdout+stderr so a `preview_failed`
  // event can carry the REAL reason the server never came up (e.g. an
  // "Unable to connect to the database" loop) instead of a black screen.
  let outputTail = '';
  // Expo: the detect prompt's `ready_pattern` is a guess about interactive
  // output ("Metro waiting"…) that a non-TTY Expo never prints. Its REAL
  // ready signal is the tunnel deep link (or the debug `Tunnel URL:` line);
  // gate on that, keeping the AI pattern only as an extra alternative.
  const readyRe = isExpo
    ? new RegExp(
        `(?:${compileReadyPattern(detection.ready_pattern).source})|exp:\\/\\/[^\\s]+\\.exp\\.(?:direct|host)|Tunnel URL:`,
        'i',
      )
    : compileReadyPattern(detection.ready_pattern);
  // Additive port-listening fallback (BUG 1) for the framework that
  // hit the hang in prod: Next.js prints `▲ Next.js 14.x` /
  // `- Local: http://localhost:3000` rather than a literal "ready"
  // line, so a slightly-off `ready_pattern` stalled WAITING_FOR_READY
  // for the full 120 s while the server was already listening. The
  // regex stays primary; the probe only catches its misses. Scoped to
  // Next.js (not Expo, whose true ready signal is its tunnel URL, nor
  // generic frameworks where the regex is reliable) to avoid flipping
  // ready before the real signal lands.
  const isNextJs = /next/i.test(detection.framework);
  const outcome = await waitForDevServerReady(devServer, readyRe, {
    timeoutMs: 120_000,
    onChunk: (s) => {
      // Keep a generous window: when a task runner (Nx, Turbo, npm
      // workspaces) fails a dependency task, the REAL error prints
      // BEFORE the terse summary line, so a small tail captures only
      // the unhelpful "N tasks failed · run with --verbose" footer.
      // 16 KB reliably includes the failing task's own stderr.
      outputTail = (outputTail + s).slice(-16_000);
      if (!expoUrlRef.current && isExpo) {
        // Parse over the accumulated tail, not the single chunk — the debug
        // line and its URL can straddle two `data` events.
        expoUrlRef.current = previewSvc.parseExpoUrl(outputTail);
      }
    },
    portProbe: isNextJs
      ? () => previewSvc.waitForPortListening(detection.port, { timeoutMs: 1_000, intervalMs: 250 })
      : undefined,
  });
  if (outcome.kind === 'exited') {
    // The dev server's parent exited, but it may have fork-exec'd a
    // worker that's still bound to the port — group-kill reaps it so the
    // next preview_start doesn't hit EADDRINUSE on a port we leaked.
    previewSvc.killProcessTree(devServer, 'SIGTERM');
    emit(USER_EVENTS.PREVIEW_ERROR, {
      stage: 'spawn',
      message: `The dev server exited (code ${outcome.code}) before it was ready. It may need a database or other services.`,
      stderrTail: outputTail.slice(-8000),
    });
    return null;
  }
  if (outcome.kind === 'timeout') {
    previewSvc.killProcessTree(devServer, 'SIGTERM');
    emit(USER_EVENTS.PREVIEW_ERROR, {
      stage: 'ready_timeout',
      message:
        "The dev server didn't become ready in time. It may be stuck waiting on a database or other service.",
      stderrTail: outputTail.slice(-8000),
    });
    return null;
  }
  emitProgress('READY_DETECTED', `port ${detection.port}`);
  return { devServer, expoUrlRef };
}

/** What stage 3 hands back for registration. */
interface TunnelUp {
  url: string;
  /** Null when the framework manages its own tunnel (Expo). */
  tunnel: ReturnType<typeof spawn> | null;
  /**
   * El proxy del inspector, cuando se pudo levantar.
   *
   * `null` significa camino directo — o porque es Expo (se auto-tunela y no
   * hay puerto nuestro que interponer), o porque el proxy no arrancó y se
   * cayó al camino de siempre. Hay que cerrarlo al parar el preview.
   */
  inspector: InspectorProxy | null;
}

/**
 * Stage 3 — public URL. Three branches per the user's session
 * environment: Expo self-tunnels; a backend-provisioned NAMED tunnel is
 * preferred; otherwise up to {@link MAX_TUNNEL_ATTEMPTS} quick-tunnel
 * attempts. Returns `null` when the pipeline must stop (error emitted,
 * dev server killed).
 */
const MAX_TUNNEL_ATTEMPTS = 3;

async function establishTunnel(ctx: StageCtx, dev: DevServerUp): Promise<TunnelUp | null> {
  const { detection, emit, emitProgress } = ctx;
  const { devServer } = dev;

  // 4. Tunnel — three branches per the user's session environment.
  emitProgress(
    'TUNNEL_STARTING',
    detection.framework === 'Expo' ? 'Expo (self-tunnelled)' : 'cloudflared quick tunnel',
  );

  if (detection.framework === 'Expo') {
    // Expo manages its own tunnel. The readiness watcher parsed the URL
    // above — wait a touch longer if it hasn't landed yet (the still-
    // attached `data` listener keeps updating `expoUrlRef`).
    if (!dev.expoUrlRef.current) {
      const expoDeadline = Date.now() + 15_000;
      while (!dev.expoUrlRef.current && Date.now() < expoDeadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const expoUrl = dev.expoUrlRef.current;
    if (!expoUrl) {
      // Solo se mata lo que arrancamos nosotros: un adoptado es el servidor
      // del usuario y matarlo sería el daño que la adopción evita.
      if (devServer) previewSvc.killProcessTree(devServer, 'SIGTERM');
      emit(USER_EVENTS.PREVIEW_ERROR, {
        stage: 'tunnel',
        message: 'Expo did not report a tunnel URL.',
      });
      return null;
    }
    // ⚠️ Expo NO lleva proxy, y no es una omisión. Expo se auto-tunela: la
    // URL sale de su propia salida (`exp://…exp.host`) y nosotros no
    // levantamos `cloudflared`, así que no hay puerto nuestro que interponer.
    // Y un inspector de DOM no significa nada contra una app nativa.
    return { url: expoUrl, tunnel: null, inspector: null };
  }

  // ALWAYS a Cloudflare Quick Tunnel — the same public-URL path for
  // codespaces, self-hosted boxes, and local CLIs, so the preview
  // behaves identically everywhere. We deliberately do NOT use GitHub
  // Codespaces port-forwarding (it required CODESPACE_NAME, which the
  // detached CLI env doesn't carry, and split behaviour by environment).
  /**
   * El proxy del inspector se interpone AQUÍ, y solo aquí.
   *
   * Después de la rama de Expo (que no lleva) y antes de que se decida el
   * túnel, porque lo único que cambia es QUÉ PUERTO recibe: `cloudflared`
   * apunta al proxy y el proxy al dev server. Si no arranca, `port` es el del
   * dev server y todo lo de abajo es byte por byte lo de siempre.
   *
   * ⚠️ Va después de la readiness a propósito. La readiness se mide contra el
   * dev server (`ready_pattern` + la sonda TCP), nunca contra el proxy: así el
   * inspector no puede hacer que un preview sano parezca roto.
   */
  const inspection = await bringUpInspector(detection.port, {
    log: (m) => log.info('preview', m),
  });
  const tunnelPort = inspection.port;

  let bin: string;
  try {
    bin = await previewSvc.resolveCloudflared();
  } catch (e) {
    if (devServer) previewSvc.killProcessTree(devServer, 'SIGTERM');
    emit(USER_EVENTS.PREVIEW_ERROR, {
      stage: 'tunnel',
      message: (e as Error).message,
    });
    return null;
  }

  // Cloudflare Quick Tunnels occasionally fail to register or are slow
  // to propagate DNS (the user hit this as an intermittent
  // ERR_TUNNEL_FAILED that "worked on the Nth manual retry"). A FRESH
  // tunnel almost always succeeds, so we auto-retry the whole bring-up
  // (spawn → URL → registered) up to 3 times with a new connector +
  // hostname each attempt, instead of surfacing the first miss to the
  // user. Each attempt's cloudflared child is killed before the next so
  // we never leak orphaned connectors.
  let tunnel: ReturnType<typeof spawn> | null = null;
  let parsedUrl: string | null = null;
  let lastTunnelErr = 'cloudflared did not emit a URL within 45s';

  // Named tunnel FIRST when the backend provisioned one. It lives under
  // our own zone (*.preview.codeagent-mobile.com), which ISP/security
  // resolvers serve reliably — unlike *.trycloudflare.com, which ANTEL
  // (and many others) resolve only intermittently, the root cause of the
  // -1003 the user hit. Delivered via env for BOTH surfaces: the
  // codespace bootstrap exports it; the host-agent exports it into the
  // child. On ANY failure we fall through to the quick-tunnel loop below.
  //
  // ⚠️ The env is no longer the ONLY source. A fleet box, a self-hosted host
  // and the shared demo session never got these exported — only the codespace
  // bootstrap does — so they rode the quick tunnel on every preview
  // (codeagent-xsot). `resolveNamedTunnel` falls back to asking the backend to
  // mint one on demand, and answers null (never throws) when there is none, so
  // the quick-tunnel loop below stays the safety net.
  const named = await resolveNamedTunnel(
    {
      sessionId: ctx.sessionId,
      pluginId: ctx.projectEnvAuth?.pluginId ?? '',
      pluginAuthToken: ctx.projectEnvAuth?.pluginAuthToken ?? '',
    },
    (c) => fetchNamedPreviewTunnel({ pluginId: c.pluginId, pluginAuthToken: c.pluginAuthToken }),
  );
  const namedToken = named?.token;
  const namedHostname = named?.hostname;
  if (namedToken && namedHostname) {
    try {
      emitProgress('TUNNEL_STARTING', `named tunnel ${namedHostname}`);
      const candidate = await previewSvc.spawnNamedTunnel(bin, namedToken, tunnelPort);
      const outcome = await previewSvc.awaitTunnelRegistered(
        candidate,
        namedHostname,
        TUNNEL_REGISTER_DEADLINE_MS,
      );
      if (outcome.kind === 'registered') {
        log.info('preview', `named tunnel registered: ${outcome.url}`);
        tunnel = candidate;
        parsedUrl = outcome.url;
      } else {
        log.info(
          'preview',
          'named tunnel did not register within 45s — falling back to quick tunnel',
        );
        killQuiet(candidate);
      }
    } catch (e) {
      log.info(
        'preview',
        `named tunnel failed (${(e as Error).message}) — falling back to quick tunnel`,
      );
    }
  }

  for (let attempt = 1; attempt <= MAX_TUNNEL_ATTEMPTS && !parsedUrl; attempt += 1) {
    if (attempt > 1) {
      emitProgress(
        'TUNNEL_STARTING',
        `cloudflared quick tunnel (retry ${attempt}/${MAX_TUNNEL_ATTEMPTS})`,
      );
    }
    const candidate = spawn(bin, ['tunnel', '--url', `http://localhost:${tunnelPort}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Wait for BOTH the URL and the registered-connection line (the
    // event-driven helper resolves straight off the child's output —
    // see tunnel-bringup.ts for why we don't DNS-probe from here).
    const outcome = await previewSvc.awaitTunnelRegistered(
      candidate,
      null,
      TUNNEL_REGISTER_DEADLINE_MS,
    );
    if (outcome.kind === 'registered') {
      log.info('preview', `cloudflared tunnel registered: ${outcome.url}`);
      tunnel = candidate;
      parsedUrl = outcome.url;
    } else {
      lastTunnelErr = outcome.sawUrl
        ? 'cloudflared did not register a tunnel connection within 45s'
        : 'cloudflared did not emit a URL within 45s';
      killQuiet(candidate);
    }
  }
  if (!parsedUrl) {
    if (devServer) previewSvc.killProcessTree(devServer, 'SIGTERM');
    emit(USER_EVENTS.PREVIEW_ERROR, {
      stage: 'tunnel',
      message: `Tunnel did not become reachable after ${MAX_TUNNEL_ATTEMPTS} attempts (${lastTunnelErr}). Cloudflare Quick Tunnels occasionally fail to register — please retry.`,
    });
    return null;
  }
  return { url: parsedUrl, tunnel, inspector: inspection.proxy };
}
