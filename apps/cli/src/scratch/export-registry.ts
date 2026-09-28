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
}

const entries = new Map<string, Entry>();

export const EXPORT_TTL_MS = 600_000;
export const EXPORT_PATH_PREFIX = '/.codeam/export/';
export const exportDir = (): string => path.join(os.homedir(), '.codeam', 'exports');

function drop(token: string): void {
  const e = entries.get(token);
  if (!e) return;
  clearTimeout(e.timer);
  entries.delete(token);
  fs.rmSync(e.file, { force: true });
}

export function registerExport(
  file: string,
  sizeBytes: number,
  onComplete: () => void,
): { token: string; expiresAt: Date } {
  const token = randomBytes(24).toString('hex');
  const expiresAt = Date.now() + EXPORT_TTL_MS;
  const timer = setTimeout(() => drop(token), EXPORT_TTL_MS);
  timer.unref();
  entries.set(token, { file, size: sizeBytes, expiresAt, timer, inFlight: false, onComplete });
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
    }
  });
  return true;
}

/** Leftovers from a previous CLI run are unreachable (their tokens died with it). */
export function purgeExports(): void {
  try {
    fs.rmSync(exportDir(), { recursive: true, force: true });
  } catch {
    // Best-effort housekeeping at CLI start: never worth failing the start over.
  }
}
