import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Point cursor's data root (`os.homedir()/.cursor`) at a throwaway dir so the
// store-bridge functions can be exercised without touching a real ~/.cursor.
const { FAKE_HOME } = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const p = require('node:path') as typeof import('node:path');
  return { FAKE_HOME: fs.mkdtempSync(p.join(os.tmpdir(), 'cursor-home-')) };
});
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => FAKE_HOME, default: { ...actual, homedir: () => FAKE_HOME } };
});

import { bridgeNativeToAcp, bridgeAcpToNative } from '../../src/agents/cursor/history';

const CURSOR = path.join(FAKE_HOME, '.cursor');
const CWD = '/Users/x/Documents/proj';
const ID = '430a9c7c-c12a-460c-820c-6abc68a19a0d';

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex');
}
function nativeDir(): string {
  return path.join(CURSOR, 'chats', md5(CWD), ID);
}
function acpDir(): string {
  return path.join(CURSOR, 'acp-sessions', ID);
}
function seedStore(dir: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'store.db'), `DB:${marker}`);
  writeFileSync(path.join(dir, 'store.db-wal'), `WAL:${marker}`);
}

describe('cursor store bridge (baton hand-off)', () => {
  beforeEach(() => {
    rmSync(path.join(CURSOR, 'chats'), { recursive: true, force: true });
    rmSync(path.join(CURSOR, 'acp-sessions'), { recursive: true, force: true });
  });

  it('bridgeNativeToAcp copies the native store + writes acp meta.json', () => {
    seedStore(nativeDir(), 'native');

    bridgeNativeToAcp(CWD, ID);

    expect(readFileSync(path.join(acpDir(), 'store.db'), 'utf8')).toBe('DB:native');
    expect(readFileSync(path.join(acpDir(), 'store.db-wal'), 'utf8')).toBe('WAL:native');
    expect(JSON.parse(readFileSync(path.join(acpDir(), 'meta.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      cwd: CWD,
    });
  });

  it('bridgeAcpToNative copies the acp store back into the existing native dir', () => {
    seedStore(nativeDir(), 'stale'); // native store from the initial local drive
    seedStore(acpDir(), 'mobile'); // acp store after mobile added a turn

    bridgeAcpToNative(CWD, ID);

    expect(readFileSync(path.join(nativeDir(), 'store.db'), 'utf8')).toBe('DB:mobile');
    expect(readFileSync(path.join(nativeDir(), 'store.db-wal'), 'utf8')).toBe('WAL:mobile');
  });

  it('replacing the store drops a stale WAL that the fresh copy lacks', () => {
    // native has a WAL; the acp source has only store.db → the copy must remove
    // the stale native WAL so it can't shadow the fresh DB on next open.
    seedStore(nativeDir(), 'stale');
    mkdirSync(acpDir(), { recursive: true });
    writeFileSync(path.join(acpDir(), 'store.db'), 'DB:mobile');

    bridgeAcpToNative(CWD, ID);

    expect(readFileSync(path.join(nativeDir(), 'store.db'), 'utf8')).toBe('DB:mobile');
    expect(existsSync(path.join(nativeDir(), 'store.db-wal'))).toBe(false);
  });

  it('is a no-op (no throw) when the source store is missing', () => {
    expect(() => bridgeNativeToAcp(CWD, ID)).not.toThrow();
    expect(existsSync(acpDir())).toBe(false);
    expect(() => bridgeAcpToNative(CWD, ID)).not.toThrow();
  });

  it('finds the native store by scanning even when the cwd hash bucket differs', () => {
    // Seed under an ARBITRARY bucket name (simulating a different OS cwd-string
    // hash); the scan must still locate <bucket>/<id>/store.db.
    const oddBucket = path.join(CURSOR, 'chats', 'deadbeefdeadbeefdeadbeefdeadbeef', ID);
    seedStore(oddBucket, 'scanned');

    bridgeNativeToAcp(CWD, ID);

    expect(readFileSync(path.join(acpDir(), 'store.db'), 'utf8')).toBe('DB:scanned');
  });
});
