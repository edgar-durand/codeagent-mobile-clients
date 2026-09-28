import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EXPORT_PATH_PREFIX,
  EXPORT_TTL_MS,
  exportDir,
  handleExportRequest,
  purgeExports,
  registerExport,
} from '../../src/scratch/export-registry';

let server: http.Server;
let port: number;
const tmpDirs: string[] = [];

function writeTmp(content: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-export-'));
  tmpDirs.push(dir);
  const f = path.join(dir, 'project.zip');
  fs.writeFileSync(f, content);
  return f;
}

interface Res {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function get(p: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }),
        );
      })
      .on('error', reject);
  });
}

/** Reads the first chunk of the body, then tears the socket down mid-transfer. */
function getAndAbort(p: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      res.once('data', () => {
        req.destroy();
        resolve();
      });
    });
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ECONNRESET') reject(e);
    });
  });
}

/**
 * A synthetic `http.ServerResponse` stand-in whose writes never complete
 * until the test releases them — holds `handleExportRequest`'s pipe mid-flight
 * deterministically (no real socket/timing race), so a fake-timer TTL
 * advance can be tested against a genuinely in-flight transfer. `.destroy()`
 * emits `close` without ever emitting `finish`, simulating an abort.
 */
class BlockableRes extends Writable {
  statusCode = 200;
  private pending: Array<(err?: Error) => void> = [];
  writeHead(): void {}
  override _write(_chunk: unknown, _enc: BufferEncoding, cb: (err?: Error) => void): void {
    this.pending.push(cb);
  }
  releaseAll(): void {
    while (this.pending.length) this.pending.shift()!();
  }
}

async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (e) {
      if (Date.now() - start > timeoutMs) throw e;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

beforeAll(async () => {
  server = http.createServer((q, s) => handleExportRequest(q, s) || ((s.statusCode = 404), s.end()));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('export registry', () => {
  it('serves once, then 404; the file is deleted and onComplete fires after a complete transfer', async () => {
    const f = writeTmp('zipbytes');
    const done = vi.fn();
    const { token, expiresAt } = registerExport(f, 8, done);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const r1 = await get(`${EXPORT_PATH_PREFIX}${token}`);
    expect(r1.status).toBe(200);
    expect(r1.body).toBe('zipbytes');
    expect(r1.headers['content-disposition']).toMatch(/attachment; filename="project\.zip"/);
    expect(r1.headers['cache-control']).toBe('no-store');
    expect(r1.headers['content-type']).toBe('application/zip');
    expect(r1.headers['content-length']).toBe('8');
    await waitFor(() => expect(fs.existsSync(f)).toBe(false));
    expect(done).toHaveBeenCalledTimes(1);
    expect((await get(`${EXPORT_PATH_PREFIX}${token}`)).status).toBe(404);
  });

  it('an unknown token is 404; a non-export path is not handled', async () => {
    expect((await get(`${EXPORT_PATH_PREFIX}${'0'.repeat(48)}`)).status).toBe(404);

    const res = { statusCode: 200, end: vi.fn() } as unknown as http.ServerResponse;
    const req = { method: 'GET', url: '/index.html' } as http.IncomingMessage;
    expect(handleExportRequest(req, res)).toBe(false);
    expect(res.end).not.toHaveBeenCalled();

    const post = { method: 'POST', url: `${EXPORT_PATH_PREFIX}abc` } as http.IncomingMessage;
    expect(handleExportRequest(post, res)).toBe(false);
  });

  it('expiry deletes the file and invalidates the token', async () => {
    const f = writeTmp('zipbytes');
    const done = vi.fn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { token } = registerExport(f, 8, done);
    vi.advanceTimersByTime(EXPORT_TTL_MS + 1);
    vi.useRealTimers();
    expect(fs.existsSync(f)).toBe(false);
    expect((await get(`${EXPORT_PATH_PREFIX}${token}`)).status).toBe(404);
    expect(done).not.toHaveBeenCalled();
  });

  it('onExpire fires once at TTL for an unused export, and a caller-supplied release runs off it', async () => {
    const f = writeTmp('zipbytes');
    const done = vi.fn();
    const release = vi.fn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { token } = registerExport(f, 8, done, release);
    vi.advanceTimersByTime(EXPORT_TTL_MS + 1);
    vi.useRealTimers();
    expect(release).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    expect(fs.existsSync(f)).toBe(false);
    expect((await get(`${EXPORT_PATH_PREFIX}${token}`)).status).toBe(404);

    // Never fires twice — advancing further must not re-invoke it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.advanceTimersByTime(EXPORT_TTL_MS * 2);
    vi.useRealTimers();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a download in flight at TTL is not cut — the timer is a no-op while inFlight', async () => {
    const f = writeTmp('zipbytes');
    const done = vi.fn();
    const onExpire = vi.fn();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { token } = registerExport(f, 8, done, onExpire);

    // Drive `handleExportRequest` directly against a response that never
    // completes its write — deterministically holds the transfer `inFlight`
    // with no real socket/timing race, so the fake-timer TTL advance below
    // lands on a genuinely in-flight entry.
    const res = new BlockableRes();
    const handled = handleExportRequest(
      { method: 'GET', url: `${EXPORT_PATH_PREFIX}${token}` } as http.IncomingMessage,
      res as unknown as http.ServerResponse,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);

    vi.advanceTimersByTime(EXPORT_TTL_MS + 1);
    vi.useRealTimers();

    // The TTL fired, but the entry was in flight — untouched. `finish`/
    // `close` (exercised by the other tests in this file) own its lifecycle
    // instead, not this timer.
    expect(onExpire).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(fs.existsSync(f)).toBe(true);

    res.releaseAll();
  });

  it('an interrupted (close-without-finish) transfer re-arms a short expiry instead of living forever', async () => {
    const f = writeTmp('zipbytes');
    const done = vi.fn();
    const onExpire = vi.fn();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { token } = registerExport(f, 8, done, onExpire);

    const res = new BlockableRes();
    handleExportRequest(
      { method: 'GET', url: `${EXPORT_PATH_PREFIX}${token}` } as http.IncomingMessage,
      res as unknown as http.ServerResponse,
    );

    // Abort mid-transfer: `close` fires WITHOUT `finish` ever having fired.
    res.destroy();
    await new Promise<void>((r) => res.on('close', r));
    expect(fs.existsSync(f)).toBe(true);
    expect(done).not.toHaveBeenCalled();
    expect(onExpire).not.toHaveBeenCalled();

    // The ORIGINAL 10-minute timer no longer governs this entry — it was
    // replaced by a short (<=60s) re-arm. Advancing just past that re-arm
    // (well short of the original TTL) is what proves the re-arm exists.
    vi.advanceTimersByTime(60_000 + 1);
    vi.useRealTimers();

    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    expect(fs.existsSync(f)).toBe(false);
  });

  it('an interrupted transfer keeps the file so the user can retry', async () => {
    const size = 2 * 1024 * 1024;
    const f = writeTmp(Buffer.alloc(size, 7));
    const done = vi.fn();
    const { token } = registerExport(f, size, done);
    await getAndAbort(`${EXPORT_PATH_PREFIX}${token}`);
    // Give the server time to observe the close.
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(f)).toBe(true);
    expect(done).not.toHaveBeenCalled();

    const r2 = await get(`${EXPORT_PATH_PREFIX}${token}`);
    expect(r2.status).toBe(200);
    expect(r2.body.length).toBe(size);
    await waitFor(() => expect(fs.existsSync(f)).toBe(false));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('a concurrent second GET while one is in flight is 404', async () => {
    const size = 8 * 1024 * 1024;
    const f = writeTmp(Buffer.alloc(size, 1));
    const { token } = registerExport(f, size, () => {});
    // Hold the first transfer open by not consuming its body.
    const first = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `${EXPORT_PATH_PREFIX}${token}`, agent: false }, resolve).on('error', reject);
    });
    first.pause();
    expect(first.statusCode).toBe(200);
    expect((await get(`${EXPORT_PATH_PREFIX}${token}`)).status).toBe(404);
    first.resume();
    await new Promise<void>((r) => first.on('end', () => r()));
  });

  it('purgeExports empties the export dir', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-home-'));
    tmpDirs.push(home);
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const dir = exportDir();
      expect(dir).toBe(path.join(home, '.codeam', 'exports'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.zip'), 'x');
      fs.writeFileSync(path.join(dir, 'b.zip'), 'y');
      purgeExports();
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
      // Idempotent when the dir does not exist.
      expect(() => purgeExports()).not.toThrow();
    } finally {
      process.env.HOME = prevHome;
    }
  });
});
