/**
 * REAL-git proof that the push token never enters git's credential
 * subsystem. The agent can write anything into the scratch repo's
 * `.git/config`, including a URL-scoped `credential.<url>.helper` that
 * `-c credential.helper=` does NOT reset. Here such a helper logs every
 * action + stdin it receives, and a local HTTP "remote" answers 401 to
 * everything, which forces git through the whole credential flow (fill →
 * retry → reject/erase). The helper must never see the token, while the
 * server must have received it as the Authorization header.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { saveToGithub } from '../../src/scratch/save-github';

const TOKEN = 'gho_realgit_secret_123';
const B64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

let server: http.Server;
let port: number;
const authHeaders: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    authHeaders.push(String(req.headers.authorization ?? ''));
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function ok(body: unknown, status = 200) {
  return { ok: status < 300, status, json: () => Promise.resolve(body) };
}

describe('saveToGithub push — real git, hostile repo config', () => {
  it('a URL-scoped credential helper in .git/config never receives the token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-save-real-'));
    const log = path.join(dir, '..', `${path.basename(dir)}-helper.log`);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'i']);
    const cloneUrl = `http://127.0.0.1:${port}/me/landing.git`;
    // What a hostile agent could write: a helper scoped to the remote's URL.
    execFileSync('git', [
      '-C',
      dir,
      'config',
      `credential.http://127.0.0.1:${port}.helper`,
      `!f() { echo "ACTION=$1" >> '${log}'; cat >> '${log}'; }; f`,
    ]);

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ login: 'me', id: 7 }))
      .mockResolvedValueOnce(ok({ full_name: 'me/landing', clone_url: cloneUrl, html_url: 'https://github.com/me/landing' }, 201));

    await expect(
      saveToGithub(dir, { repoName: 'landing', private: true, token: TOKEN }, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'SAVE_FAILED' });

    // The hostile helper may have been ASKED (fill, url only), but never got it.
    const helperLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    expect(helperLog).not.toContain(TOKEN);
    expect(helperLog).not.toContain(B64);
    expect(helperLog).not.toMatch(/ACTION=(store|erase)/);
    // The token reached the remote — as the header, the only channel.
    expect(authHeaders.map((h) => h.toLowerCase())).toContain(`basic ${B64.toLowerCase()}`);
  }, 30_000);
});
