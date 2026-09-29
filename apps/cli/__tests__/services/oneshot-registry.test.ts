import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isOneShotConversation,
  readOneShotConversations,
  registerOneShotConversation,
} from '../../src/services/oneshot-registry';

/**
 * `claude -p` one-shots (preview detect, AI summary/insights) write their own
 * transcript into the session's project dir. The registry remembers their ids
 * so the RECENT list, the history detector and the resume pick can skip them.
 */
describe('one-shot conversation registry', () => {
  let cwd: string;
  let home: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-oneshot-cwd-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-oneshot-home-'));
  });

  it('round-trips outside the project tree, keyed by cwd', () => {
    registerOneShotConversation(cwd, 'a', home);
    registerOneShotConversation(cwd, 'b', home);
    registerOneShotConversation(cwd, 'a', home);
    expect([...readOneShotConversations(cwd, home)].sort()).toEqual(['a', 'b']);
    expect(isOneShotConversation(cwd, 'b', home)).toBe(true);
    expect(isOneShotConversation(cwd, 'c', home)).toBe(false);
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(readOneShotConversations(path.join(cwd, 'other'), home).size).toBe(0);
  });

  it('keeps only the most recent 100 ids', () => {
    for (let i = 0; i < 105; i++) registerOneShotConversation(cwd, `id-${i}`, home);
    const ids = readOneShotConversations(cwd, home);
    expect(ids.size).toBe(100);
    expect(ids.has('id-4')).toBe(false);
    expect(ids.has('id-5')).toBe(true);
    expect(ids.has('id-104')).toBe(true);
  });

  it('reads an empty set for a missing or malformed file, and recovers on write', () => {
    expect(readOneShotConversations(cwd, home).size).toBe(0);
    registerOneShotConversation(cwd, 'a', home);
    const dir = path.join(home, '.codeam', 'oneshot-conversations');
    const [file] = fs.readdirSync(dir);
    fs.writeFileSync(path.join(dir, file), '{');
    expect(readOneShotConversations(cwd, home).size).toBe(0);
    fs.writeFileSync(path.join(dir, file), '{"ids":[42,"x"]}');
    expect([...readOneShotConversations(cwd, home)]).toEqual(['x']);
    fs.writeFileSync(path.join(dir, file), '"nope"');
    registerOneShotConversation(cwd, 'b', home);
    expect([...readOneShotConversations(cwd, home)]).toEqual(['b']);
  });
});
