import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { makeConfig } from '../../src/config';
import { OutputService, _transport } from '../../src/services/output.service';

let tempDir: string;
let cfg: ReturnType<typeof makeConfig>;

beforeEach(() => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-token-test-'));
  cfg = makeConfig(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('config: pluginAuthToken persistence', () => {
  it('addSession persists pluginAuthToken when provided', () => {
    cfg.addSession({
      id: 'sess-1',
      pluginId: 'plg-1',
      userName: 'Edgar',
      userEmail: 'e@e.com',
      plan: 'PRO',
      pairedAt: 1000,
      pluginAuthToken: 'v1.abc',
    });
    const stored = cfg.getActiveSession();
    expect(stored?.pluginAuthToken).toBe('v1.abc');

    // And re-reading from disk via a fresh config instance still has it.
    const cfg2 = makeConfig(tempDir);
    expect(cfg2.getActiveSession()?.pluginAuthToken).toBe('v1.abc');
  });

  it('addSession works without pluginAuthToken (legacy upgrade path)', () => {
    cfg.addSession({
      id: 'sess-2',
      pluginId: 'plg-2',
      userName: 'Edgar',
      userEmail: 'e@e.com',
      plan: 'FREE',
      pairedAt: 2000,
    });
    const stored = cfg.getActiveSession();
    expect(stored?.pluginAuthToken).toBeUndefined();
  });
});

describe('OutputService: X-Plugin-Auth-Token header', () => {
  it('includes X-Plugin-Auth-Token header when pluginAuthToken is set', async () => {
    const sendSpy = vi
      .spyOn(_transport, 'sendOutputChunk')
      .mockResolvedValue({ statusCode: 200, body: '' });

    const svc = new OutputService(
      'sess-1',
      'plg-1',
      undefined,
      undefined,
      undefined,
      undefined,
      'v1.abc',
    );

    // newTurn() fires postChunk — clear: true and new_turn, both critical.
    svc.newTurn();
    // Yield to let the .then() / catch() chain settle.
    await new Promise((r) => setImmediate(r));
    svc.dispose();

    expect(sendSpy).toHaveBeenCalled();
    const [url, headers, payload] = sendSpy.mock.calls[0];
    expect(url).toMatch(/\/api\/commands\/output$/);
    expect(headers['X-Plugin-Auth-Token']).toBe('v1.abc');
    expect(headers['Content-Type']).toBe('application/json');
    // Payload still includes session + plugin id alongside the body.
    const parsed = JSON.parse(payload);
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.pluginId).toBe('plg-1');
  });

  it('omits X-Plugin-Auth-Token header when pluginAuthToken is undefined (legacy)', async () => {
    const sendSpy = vi
      .spyOn(_transport, 'sendOutputChunk')
      .mockResolvedValue({ statusCode: 200, body: '' });

    const svc = new OutputService(
      'sess-2',
      'plg-2',
      // No pluginAuthToken arg — sessions paired before this field existed.
    );

    svc.newTurn();
    await new Promise((r) => setImmediate(r));
    svc.dispose();

    expect(sendSpy).toHaveBeenCalled();
    const [, headers] = sendSpy.mock.calls[0];
    expect(headers['X-Plugin-Auth-Token']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });
});
