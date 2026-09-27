import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Minimal tagged stderr logger for the CLI.
 *
 * Writes to `process.stderr` so it never collides with PTY output on `stdout`
 * (Claude Code's TUI). Level is controlled by the `CODEAM_LOG` env var:
 *
 *   CODEAM_LOG=silent   → suppress everything
 *   CODEAM_LOG=error    → default; only errors
 *   CODEAM_LOG=warn     → errors + warnings
 *   CODEAM_LOG=info     → errors + warnings + info breadcrumbs
 *   CODEAM_LOG=debug    → everything (incl. trace breadcrumbs)
 *
 * **Trace mode**: setting `CODEAM_DEBUG=1` (or `CODEAM_LOG=debug`) ALSO
 * mirrors every line into the file log (see "File rotation" below).
 *
 * **JSON mode**: `CODEAM_LOG_JSON=1` switches the file output (and
 * stderr if enabled) to one-line NDJSON: each entry is
 * `{ts, level, tag, msg, ctx?}`. jq + fluentbit + Datadog all parse
 * this natively. Defaults to the human-readable text format.
 *
 * **File rotation** (#66): the log file is rotated when it crosses
 * `MAX_LOG_BYTES` (5 MB). On rotation, the current file is moved to
 * `debug-<pid>.log.old` and a fresh one is started; the previous
 * `.old` file is then aged out to numbered archives
 * (`debug-<pid>.log.1`, `.2`, …) up to `MAX_ARCHIVES` (5). Older
 * archives are deleted. This caps disk use at ~30 MB per active
 * pid in the worst case (5 MB live + 5 × 5 MB archives).
 *
 * **Log location** (#66): respects platform conventions before
 * falling back to `~/.codeam`. Resolution priority:
 *   Linux:   XDG_STATE_HOME/codeam       (XDG Base Dir spec)
 *   Windows: %LOCALAPPDATA%\codeam\Logs  (Microsoft store-app norm)
 *   Else:    ~/.codeam                   (legacy default; macOS lands here)
 */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 } as const;
type Level = keyof typeof LEVELS;

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVES = 5;

function currentLevel(): number {
  // CODEAM_DEBUG=1 is a shortcut for CODEAM_LOG=trace.
  if (process.env.CODEAM_DEBUG === '1') return LEVELS.trace;
  const raw = (process.env.CODEAM_LOG ?? 'error').toLowerCase() as Level;
  return LEVELS[raw] ?? LEVELS.error;
}

const verboseFileEnabled =
  process.env.CODEAM_DEBUG === '1' ||
  process.env.CODEAM_LOG === 'debug' ||
  process.env.CODEAM_LOG === 'trace';

const jsonMode = process.env.CODEAM_LOG_JSON === '1';

/**
 * Resolve the directory the log file lives in. Honours XDG on
 * Linux and LOCALAPPDATA on Windows so backup tools that follow
 * those conventions pick the file up. macOS lands on the legacy
 * `~/.codeam` because macOS apps conventionally use
 * `~/Library/Logs/<app>` — that bigger migration is out of scope
 * for #66; keep the legacy path stable.
 */
export function resolveLogDir(): string {
  if (process.platform === 'linux') {
    const xdgState = process.env.XDG_STATE_HOME;
    if (xdgState && xdgState.length > 0) return path.join(xdgState, 'codeam');
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local && local.length > 0) return path.join(local, 'codeam', 'Logs');
  }
  return path.join(os.homedir(), '.codeam');
}

const LOG_DIR = resolveLogDir();
// Per-process active log file so concurrent CLI invocations don't
// trample each other's headers. Rotation history (`.old`, `.1`, …)
// is also per-pid so cleanup is bounded.
const debugFilePath = path.join(LOG_DIR, `debug-${process.pid}.log`);

let fileInitialized = false;

/**
 * Set once stderr can no longer be written — its reader is gone (EPIPE). The
 * file mirror keeps working; only the console copy stops.
 *
 * ⚠️ Without this a session daemon orphaned by a host-agent restart (its
 * stderr pipe's read end died with the old supervisor) wedged for good: the
 * write failed asynchronously → `uncaughtException` → the relay guard's
 * `log.error` → another stderr write → another EPIPE, forever, on
 * `process.nextTick`, starving the event loop. No heartbeat ever left, so the
 * session showed offline and the NEW host-agent deferred to that live-but-dead
 * daemon (QA codespace, 2026-09-27: 1.6 GB of EPIPE lines in ~7 h).
 */
let consoleBroken = false;
process.stderr.on('error', () => {
  consoleBroken = true;
});

function writeConsole(line: string): void {
  if (consoleBroken) return;
  try {
    process.stderr.write(line);
  } catch {
    consoleBroken = true;
  }
}

const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_DIR_BUDGET_BYTES = 200 * 1024 * 1024;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Delete the logs of processes that are gone: older than 7 days, or beyond a
 * 200 MB budget for the directory (newest kept first). Rotation is per-pid, so
 * without this every new pid adds files forever — a host-agent restarting a
 * child every few minutes left 2,839 logs / 12 GB on the fleet VPS
 * (2026-09-27). Never touches this process or any live one. Best-effort.
 */
export function pruneStaleLogs(
  dir: string,
  now: number = Date.now(),
  isAlive: (pid: number) => boolean = pidAlive,
): number {
  let removed = 0;
  try {
    const entries = fs
      .readdirSync(dir)
      .map((name) => ({ name, m: /^debug-(\d+)\.log/.exec(name) }))
      .filter((e): e is { name: string; m: RegExpExecArray } => e.m !== null)
      .map(({ name, m }) => {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        return { full, pid: Number(m[1]), mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
    let used = 0;
    for (const e of entries) {
      used += e.size;
      if (e.pid === process.pid || isAlive(e.pid)) continue;
      if (now - e.mtime > LOG_RETENTION_MS || used > LOG_DIR_BUDGET_BYTES) {
        try {
          fs.unlinkSync(e.full);
          removed++;
          used -= e.size;
        } catch {
          /* raced another pruner — fine */
        }
      }
    }
  } catch {
    /* unreadable dir — nothing to prune */
  }
  return removed;
}

/**
 * Rotate `debugFilePath` out of the way before writing if it has
 * crossed MAX_LOG_BYTES. Cheap stat once per `appendToFile` call —
 * filesystems cache the stat aggressively and this avoids reading
 * the file. Idempotent: missing files and missing archive slots
 * just no-op.
 */
function maybeRotate(): void {
  try {
    const st = fs.statSync(debugFilePath);
    if (st.size < MAX_LOG_BYTES) return;
  } catch {
    // No file yet → nothing to rotate.
    return;
  }
  rotateNow();
}

/** Shift the current file into the bounded archive chain (`.old`, `.1`, …). */
function rotateNow(): void {
  // Shift `.N` → `.N+1` from the top down so we never overwrite an
  // existing archive. Deletes the oldest beyond MAX_ARCHIVES.
  const archivePath = (n: number): string =>
    n === 0 ? `${debugFilePath}.old` : `${debugFilePath}.${n}`;
  for (let i = MAX_ARCHIVES - 1; i >= 0; i--) {
    const src = archivePath(i);
    const dst = archivePath(i + 1);
    try {
      fs.renameSync(src, dst);
    } catch {
      /* missing slot — that's fine */
    }
  }
  // Final aged-out slot (MAX_ARCHIVES) becomes obsolete — delete.
  try { fs.unlinkSync(archivePath(MAX_ARCHIVES)); } catch { /* already gone */ }
  // Move current → .old.
  try { fs.renameSync(debugFilePath, archivePath(0)); } catch { /* race — already rotated */ }
  // Force a fresh header on the next write.
  fileInitialized = false;
}

function appendToFile(line: string): void {
  try {
    if (!fileInitialized) {
      fs.mkdirSync(path.dirname(debugFilePath), { recursive: true, mode: 0o700 });
      pruneStaleLogs(path.dirname(debugFilePath));
      // ⚠️ A file already here belongs to an EARLIER process that had the same
      // pid — in a container that is every boot (the Box host-agent is always
      // pid 1). Writing the header below replaces it, so each wake erased the
      // previous boot's log: the only record of why a session was not resumed
      // (codeagent-bcvb). Archive it into the same bounded chain instead.
      if (fs.existsSync(debugFilePath)) rotateNow();
      const header = jsonMode
        ? `${JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            tag: 'logger',
            msg: `debug log started`,
            ctx: {
              pid: process.pid,
              platform: process.platform,
              node: process.version,
              cwd: process.cwd(),
              dir: LOG_DIR,
            },
          })}\n`
        : `=== codeam debug log — pid ${process.pid} — ${new Date().toISOString()} ===\n` +
          `platform=${process.platform} node=${process.version} cwd=${process.cwd()} dir=${LOG_DIR}\n\n`;
      // Atomic stage-then-rename: a SIGKILL between write and the
      // first appendFileSync below can't leave the file with a
      // partial header.
      const tmp = `${debugFilePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, header);
      fs.renameSync(tmp, debugFilePath);
      fileInitialized = true;
    }
    fs.appendFileSync(debugFilePath, line);
    // Rotation check is per-write; cheap (one stat) + ensures we
    // never grow past the cap. We check AFTER the write so the line
    // that crossed the threshold is preserved in `.old` instead of
    // truncated mid-emit.
    maybeRotate();
  } catch { /* unwritable home — give up silently */ }
}

function formatEntry(
  level: Level,
  tag: string,
  msg: string,
  err: unknown,
): { text: string; json: string } {
  const detail = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : '';
  const text = `[codeam:${level}] ${tag} — ${msg}${detail}\n`;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    tag,
    msg,
  };
  if (err !== undefined) {
    entry.ctx = err instanceof Error ? { errorName: err.name, errorMessage: err.message } : { error: String(err) };
  }
  return { text, json: `${JSON.stringify(entry)}\n` };
}

function emit(level: Level, tag: string, msg: string, err?: unknown): void {
  const { text, json } = formatEntry(level, tag, msg, err);

  // File mirror happens FIRST, gated only by the file policy below.
  // Doing this before the stderr filter is critical — the stderr
  // level guard suppresses noisy output for normal users, but the
  // file should always carry the always-on diagnostics regardless of
  // whether the user has CODEAM_LOG set.
  //
  // Policy:
  //   - error / warn / info → always mirrored (always-on diagnostics)
  //   - debug / trace       → only when CODEAM_DEBUG=1 or CODEAM_LOG=debug|trace
  if (LEVELS[level] <= LEVELS.info || verboseFileEnabled) {
    appendToFile(jsonMode ? json : `${new Date().toISOString()} ${text}`);
  }

  // Stderr is gated by the user's level pref (default `error`) so
  // the terminal stays quiet while the file still gets everything.
  if (LEVELS[level] <= currentLevel()) {
    writeConsole(jsonMode ? json : text);
  }
}

export const log = {
  error: (tag: string, msg: string, err?: unknown): void => emit('error', tag, msg, err),
  warn: (tag: string, msg: string, err?: unknown): void => emit('warn', tag, msg, err),
  info: (tag: string, msg: string, err?: unknown): void => emit('info', tag, msg, err),
  debug: (tag: string, msg: string, err?: unknown): void => emit('debug', tag, msg, err),
  /**
   * Verbose pipeline breadcrumb. Only fires when CODEAM_LOG=trace or
   * CODEAM_DEBUG=1, so call sites can be liberal — they have zero
   * cost in normal runs.
   */
  trace: (tag: string, msg: string, err?: unknown): void => emit('trace', tag, msg, err),
};

/** Test-only escape hatches. */
export const _logHelpers = {
  /** Force re-resolution of `LOG_DIR` next time the logger boots. */
  resetForTests(): void {
    fileInitialized = false;
    consoleBroken = false;
  },
  getDebugFilePath(): string {
    return debugFilePath;
  },
  getMaxLogBytes(): number {
    return MAX_LOG_BYTES;
  },
};
