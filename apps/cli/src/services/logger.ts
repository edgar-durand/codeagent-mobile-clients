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
 * mirrors every line into `~/.codeam/debug.log` (truncated on first
 * write per process). Use this when reproducing a hard-to-diagnose
 * issue on a remote machine — you can attach the file to the bug
 * report and we get a full timeline of the pipeline (PTY data, output
 * service ticks, command receipts, postChunk results) without a
 * round-trip of "add a console.log".
 *
 * The trace channel is intentionally chatty — keep it OFF in normal
 * runs. The default `error` level is what users see day-to-day.
 */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 } as const;
type Level = keyof typeof LEVELS;

function currentLevel(): number {
  // CODEAM_DEBUG=1 is a shortcut for CODEAM_LOG=trace.
  if (process.env.CODEAM_DEBUG === '1') return LEVELS.trace;
  const raw = (process.env.CODEAM_LOG ?? 'error').toLowerCase() as Level;
  return LEVELS[raw] ?? LEVELS.error;
}

const fileEnabled = process.env.CODEAM_DEBUG === '1' || process.env.CODEAM_LOG === 'debug' || process.env.CODEAM_LOG === 'trace';
const debugFilePath = path.join(os.homedir(), '.codeam', 'debug.log');
let fileInitialized = false;

function appendToFile(line: string): void {
  if (!fileEnabled) return;
  try {
    if (!fileInitialized) {
      fs.mkdirSync(path.dirname(debugFilePath), { recursive: true });
      // Truncate on first write per process so each run starts fresh.
      fs.writeFileSync(
        debugFilePath,
        `=== codeam debug log — pid ${process.pid} — ${new Date().toISOString()} ===\n` +
        `platform=${process.platform} node=${process.version} cwd=${process.cwd()}\n\n`,
      );
      fileInitialized = true;
    }
    fs.appendFileSync(debugFilePath, line);
  } catch { /* unwritable home — give up silently */ }
}

function emit(level: Level, tag: string, msg: string, err?: unknown): void {
  if (LEVELS[level] > currentLevel()) return;
  const detail = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : '';
  const line = `[codeam:${level}] ${tag} — ${msg}${detail}\n`;
  process.stderr.write(line);
  // File mirror for debug+ levels gets a timestamp prefix.
  if (LEVELS[level] >= LEVELS.debug) {
    appendToFile(`${new Date().toISOString()} ${line}`);
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
