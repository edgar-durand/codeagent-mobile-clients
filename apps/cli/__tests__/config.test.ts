import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tempDir: string;
let cfg: ReturnType<typeof import('../src/config').makeConfig>;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-test-'));
  const { makeConfig } = await import('../src/config');
  cfg = makeConfig(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('makeConfig', () => {
  it('generates a stable pluginId on first call and reuses it', () => {
    const id1 = cfg.ensurePluginId();
    const id2 = cfg.ensurePluginId();
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
    expect(id1).toBe(id2);
  });

  it('addSession saves and getActiveSession returns it', () => {
    cfg.addSession({ id: 's1', userName: 'Edgar', userEmail: 'e@e.com', plan: 'PRO', pairedAt: 1000 });
    const active = cfg.getActiveSession();
    expect(active?.id).toBe('s1');
    expect(active?.userName).toBe('Edgar');
  });

  it('addSession sets first session as active automatically', () => {
    cfg.addSession({ id: 's1', userName: 'A', userEmail: 'a@a.com', plan: 'FREE', pairedAt: 1000 });
    expect(cfg.getConfig().activeSessionId).toBe('s1');
  });

  it('addSession does not overwrite an existing activeSessionId', () => {
    cfg.addSession({ id: 's1', userName: 'A', userEmail: 'a@a.com', plan: 'FREE', pairedAt: 1000 });
    cfg.addSession({ id: 's2', userName: 'B', userEmail: 'b@b.com', plan: 'PRO', pairedAt: 2000 });
    expect(cfg.getConfig().activeSessionId).toBe('s1');
  });

  it('removeSession deletes the session and promotes next as active', () => {
    cfg.addSession({ id: 's1', userName: 'A', userEmail: 'a@a.com', plan: 'FREE', pairedAt: 1000 });
    cfg.addSession({ id: 's2', userName: 'B', userEmail: 'b@b.com', plan: 'PRO', pairedAt: 2000 });
    cfg.setActiveSession('s1');
    cfg.removeSession('s1');
    const config = cfg.getConfig();
    expect(config.sessions.find(s => s.id === 's1')).toBeUndefined();
    expect(config.activeSessionId).toBe('s2');
  });

  it('setActiveSession changes the active session', () => {
    cfg.addSession({ id: 's1', userName: 'A', userEmail: 'a@a.com', plan: 'FREE', pairedAt: 1000 });
    cfg.addSession({ id: 's2', userName: 'B', userEmail: 'b@b.com', plan: 'PRO', pairedAt: 2000 });
    cfg.setActiveSession('s2');
    expect(cfg.getConfig().activeSessionId).toBe('s2');
  });

  it('clearAll removes the config file', () => {
    cfg.ensurePluginId(); // creates file
    cfg.clearAll();
    expect(cfg.getConfig().sessions).toEqual([]);
  });

  it('getActiveSession heals a stale activeSessionId that points to nonexistent session', () => {
    // Manually write a config where activeSessionId points to a non-existent session
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(tempDir, '.codeam', 'config.json');
    fs.mkdirSync(path.join(tempDir, '.codeam'), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ pluginId: 'test-id', activeSessionId: 'ghost-id', sessions: [] }),
      'utf-8',
    );

    const result = cfg.getActiveSession();
    expect(result).toBeNull();

    // Verify the stale pointer was cleared from disk
    const onDisk = cfg.getConfig();
    expect(onDisk.activeSessionId).toBeNull();
  });
});
