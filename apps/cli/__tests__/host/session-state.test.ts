import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_MAX_RESUME_SESSIONS,
  MAX_RESUME_SESSIONS_CEILING,
  fileSessionChildStore,
  hostSessionStatePath,
  pickSavedSessionForWorkspace,
  planSessionResume,
  resolveMaxResumeSessions,
  type PersistedSessionChild,
} from '../../src/commands/host/session-state';
import type { SavedSession } from '../../src/config';

// codeagent-v07a: the host-agent's persisted live-children set + the bounded
// boot-resume plan (newest N resume, the rest are ENDED explicitly).

const rec = (deployId: string, startedAt: number, cwd = `/ws/${deployId}`): PersistedSessionChild => ({
  deployId,
  cwd,
  agent: 'claude',
  startedAt,
});

describe('planSessionResume', () => {
  it('resumes the newest `max` by startedAt and drops the rest (oldest)', () => {
    const { resume, dropped } = planSessionResume(
      [rec('a', 100), rec('b', 300), rec('c', 200), rec('d', 50)],
      3,
    );
    expect(resume.map((r) => r.deployId)).toEqual(['b', 'c', 'a']);
    expect(dropped.map((r) => r.deployId)).toEqual(['d']);
  });

  it('dedupes by deployId (last write wins) and tolerates max > size', () => {
    const { resume, dropped } = planSessionResume([rec('a', 1), rec('a', 9)], 3);
    expect(resume).toEqual([rec('a', 9)]);
    expect(dropped).toEqual([]);
  });

  it('with max 0 nothing resumes and everything is dropped', () => {
    const { resume, dropped } = planSessionResume([rec('a', 1), rec('b', 2)], 0);
    expect(resume).toEqual([]);
    expect(dropped.map((r) => r.deployId)).toEqual(['b', 'a']);
  });
});

describe('resolveMaxResumeSessions', () => {
  it('defaults to 3 and clamps the env override to 1..10', () => {
    expect(DEFAULT_MAX_RESUME_SESSIONS).toBe(3);
    expect(resolveMaxResumeSessions({})).toBe(3);
    expect(resolveMaxResumeSessions({ CODEAM_HOST_MAX_RESUME_SESSIONS: '' })).toBe(3);
    expect(resolveMaxResumeSessions({ CODEAM_HOST_MAX_RESUME_SESSIONS: '5' })).toBe(5);
    expect(resolveMaxResumeSessions({ CODEAM_HOST_MAX_RESUME_SESSIONS: '1' })).toBe(1);
    expect(resolveMaxResumeSessions({ CODEAM_HOST_MAX_RESUME_SESSIONS: '99' })).toBe(MAX_RESUME_SESSIONS_CEILING);
    expect(resolveMaxResumeSessions({ CODEAM_HOST_MAX_RESUME_SESSIONS: '0' })).toBe(3);
    expect(resolveMaxResumeSessions({ CODEAM_HOST_MAX_RESUME_SESSIONS: 'lots' })).toBe(3);
    expect(resolveMaxResumeSessions({ CODEAM_HOST_MAX_RESUME_SESSIONS: '2.9' })).toBe(2);
  });
});

describe('pickSavedSessionForWorkspace', () => {
  const base: SavedSession = {
    id: 's',
    userName: 'u',
    userEmail: 'e',
    plan: 'pro',
    pairedAt: 0,
    agent: 'claude',
  };

  it('picks the newest pairing for the SAME workspace that carries reconnect material', () => {
    const sessions: SavedSession[] = [
      { ...base, id: 'old', cwd: '/ws/a', pluginId: 'p1', pollSecret: 'x', pairedAt: 1 },
      { ...base, id: 'new', cwd: '/ws/a/', pluginId: 'p2', pollSecret: 'y', pairedAt: 2 },
      { ...base, id: 'other', cwd: '/ws/b', pluginId: 'p3', pollSecret: 'z', pairedAt: 3 },
      { ...base, id: 'no-secret', cwd: '/ws/a', pluginId: 'p4', pairedAt: 4 },
    ];
    expect(pickSavedSessionForWorkspace(sessions, '/ws/a')?.id).toBe('new');
    expect(pickSavedSessionForWorkspace(sessions, '/ws/b')?.id).toBe('other');
  });

  it('returns null when the session was deleted from the app (absent from the config)', () => {
    expect(pickSavedSessionForWorkspace([], '/ws/a')).toBeNull();
    expect(pickSavedSessionForWorkspace([{ ...base, cwd: '/ws/z', pluginId: 'p', pollSecret: 's' }], '/ws/a')).toBeNull();
  });
});

describe('fileSessionChildStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-sessions-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips the list atomically with owner-only mode, and clear() removes it', () => {
    const file = path.join(dir, 'nested', 'host-agent-sessions.json');
    const store = fileSessionChildStore(file);
    expect(store.load()).toEqual([]);
    store.save([rec('a', 1), rec('b', 2)]);
    expect(store.load()).toEqual([rec('a', 1), rec('b', 2)]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['host-agent-sessions.json']); // no tmp left
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    store.clear();
    expect(fs.existsSync(file)).toBe(false);
    expect(store.load()).toEqual([]);
  });

  it('ignores malformed files and malformed entries instead of throwing', () => {
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '{not json');
    expect(fileSessionChildStore(file).load()).toEqual([]);
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, sessions: [rec('ok', 1), { deployId: 'x' }, 'junk', null] }),
    );
    expect(fileSessionChildStore(file).load()).toEqual([rec('ok', 1)]);
  });

  it('save() never throws on an unwritable location', () => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const store = fileSessionChildStore(path.join(blocker, 'inside', 's.json'));
    expect(() => store.save([rec('a', 1)])).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });

  it('hostSessionStatePath honours the env override and defaults under ~/.codeam', () => {
    expect(hostSessionStatePath({ CODEAM_HOST_SESSION_STATE_FILE: '/x/y.json' })).toBe('/x/y.json');
    expect(hostSessionStatePath({})).toBe(path.join(os.homedir(), '.codeam', 'host-agent-sessions.json'));
  });
});
