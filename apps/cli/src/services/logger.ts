/**
 * Minimal tagged stderr logger for the CLI.
 *
 * Writes to `process.stderr` so it never collides with PTY output on `stdout`
 * (Claude Code's TUI). Level is controlled by the `CODEAM_LOG` env var:
 *
 *   CODEAM_LOG=silent   → suppress everything
 *   CODEAM_LOG=error    → default; only errors
 *   CODEAM_LOG=warn     → errors + warnings
 *   CODEAM_LOG=debug    → everything including debug breadcrumbs
 *
 * Replaces silent `.catch(() => null)` patterns at call sites where the
 * failure is worth leaving a breadcrumb (unexpected FS errors, non-2xx
 * API responses) without changing the resilient fallback behavior.
 */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
type Level = keyof typeof LEVELS;

function currentLevel(): number {
  const raw = (process.env.CODEAM_LOG ?? 'error').toLowerCase() as Level;
  return LEVELS[raw] ?? LEVELS.error;
}

function emit(level: Level, tag: string, msg: string, err?: unknown): void {
  if (LEVELS[level] > currentLevel()) return;
  const detail = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : '';
  process.stderr.write(`[codeam:${level}] ${tag} — ${msg}${detail}\n`);
}

export const log = {
  error: (tag: string, msg: string, err?: unknown): void => emit('error', tag, msg, err),
  warn: (tag: string, msg: string, err?: unknown): void => emit('warn', tag, msg, err),
  info: (tag: string, msg: string, err?: unknown): void => emit('info', tag, msg, err),
  debug: (tag: string, msg: string, err?: unknown): void => emit('debug', tag, msg, err),
};
