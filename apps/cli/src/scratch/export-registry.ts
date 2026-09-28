import { randomBytes } from 'crypto';
import * as fs from 'fs';
import type * as http from 'http';
import * as os from 'os';
import * as path from 'path';

/**
 * One-shot scratch ZIP exports, served over the box's tunnel at
 * `/.codeam/export/<token>` (spec D11). A token is random, single-use and
 * lives 10 minutes; the ZIP behind it is deleted after a COMPLETE transfer or
 * at expiry, whichever comes first.
 */
interface Entry {
  file: string;
  size: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
  inFlight: boolean;
  onComplete: () => void;
  onExpire: () => void;
}

const entries = new Map<string, Entry>();

export const EXPORT_TTL_MS = 600_000;
/** Cap on the re-armed expiry after an interrupted (close-without-finish)
 *  transfer — see {@link armExpiry}. */
const RETRY_WINDOW_MS = 60_000;
export const EXPORT_PATH_PREFIX = '/.codeam/export/';
const exportsBaseDir = (): string => path.join(os.homedir(), '.codeam', 'exports');
/**
 * Per-process: several CLIs (sessions) on one box share `~/.codeam/exports`,
 * and one starting up must never delete another's live downloads.
 */
export const exportDir = (): string => path.join(exportsBaseDir(), String(process.pid));

function drop(token: string): void {
  const e = entries.get(token);
  if (!e) return;
  clearTimeout(e.timer);
  entries.delete(token);
  fs.rmSync(e.file, { force: true });
}

/**
 * Arms (or re-arms) the timer that expires `token` after `ms`. A transfer
 * that's actively streaming when this fires is NEVER cut — `finish`/`close`
 * own that entry's lifecycle instead (drop-on-finish, or `close`'s own
 * re-arm on an interrupted one). Returns the new timer so the caller can
 * store it on the entry.
 */
function armExpiry(token: string, ms: number): NodeJS.Timeout {
  const timer = setTimeout(() => {
    const e = entries.get(token);
    if (!e || e.inFlight) return;
    drop(token);
    e.onExpire();
  }, ms);
  timer.unref();
  return timer;
}

export function registerExport(
  file: string,
  sizeBytes: number,
  onComplete: () => void,
  /**
   * Fires when the token expires WITHOUT a download (never on a completed
   * one — that's `onComplete`). Lets a caller holding a resource for the
   * lifetime of the export (e.g. the export tunnel's hold) release it even
   * when the user never downloads. Additive — defaults to a no-op so
   * existing 3-arg callers are unaffected.
   */
  onExpire: () => void = () => {},
): { token: string; expiresAt: Date } {
  const token = randomBytes(24).toString('hex');
  const expiresAt = Date.now() + EXPORT_TTL_MS;
  const timer = armExpiry(token, EXPORT_TTL_MS);
  entries.set(token, {
    file,
    size: sizeBytes,
    expiresAt,
    timer,
    inFlight: false,
    onComplete,
    onExpire,
  });
  return { token, expiresAt: new Date(expiresAt) };
}

/**
 * Single-use download (spec D11): deleted after a COMPLETE transfer; an
 * interrupted one keeps the file until expiry so a retry works. Returns true
 * when the request was an export request (answered here, 200 or 404).
 */
export function handleExportRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.method !== 'GET' || !req.url?.startsWith(EXPORT_PATH_PREFIX)) return false;
  const token = req.url.slice(EXPORT_PATH_PREFIX.length).split('?')[0];
  const e = entries.get(token);
  // A second GET while one is streaming is refused: the token is single-use.
  if (!e || e.inFlight || !fs.existsSync(e.file)) {
    res.statusCode = 404;
    res.end();
    return true;
  }
  e.inFlight = true;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': String(e.size),
    'Content-Disposition': 'attachment; filename="project.zip"',
    'Cache-Control': 'no-store',
  });
  const stream = fs.createReadStream(e.file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  res.on('finish', () => {
    drop(token);
    e.onComplete();
  });
  res.on('close', () => {
    if (!res.writableFinished) {
      e.inFlight = false;
      stream.destroy();
      // The TTL timer armed at register time may have already fired while
      // this transfer was in flight (skipped a no-op, per `armExpiry`) — an
      // interrupted transfer needs its OWN, short re-arm so the entry still
      // gets cleaned up (or a retry can still land) instead of living
      // forever.
      clearTimeout(e.timer);
      const remaining = Math.max(0, e.expiresAt - Date.now());
      e.timer = armExpiry(token, Math.min(remaining, RETRY_WINDOW_MS));
    }
  });
  return true;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but not ours to signal; only ESRCH means gone.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Leftovers from CLI runs that are gone are unreachable (their tokens died
 * with them): removes every `<pid>/` dir whose process is dead — and our OWN
 * pid's, which at start can only be a previous process's that reused it —
 * plus legacy loose files (pre-per-process layout) once past the TTL. Another
 * running CLI's dir is left alone.
 */
export function purgeExports(): void {
  const base = exportsBaseDir();
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const name of names) {
    const abs = path.join(base, name);
    try {
      const st = fs.lstatSync(abs);
      const stale = st.isDirectory() && /^\d+$/.test(name)
        ? Number(name) === process.pid || !isPidAlive(Number(name))
        : Date.now() - st.mtimeMs > EXPORT_TTL_MS;
      if (stale) fs.rmSync(abs, { recursive: true, force: true });
    } catch {
      // Best-effort housekeeping at CLI start: never worth failing the start over.
    }
  }
}
