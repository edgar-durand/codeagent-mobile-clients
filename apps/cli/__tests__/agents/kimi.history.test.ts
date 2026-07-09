import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  resolveHistoryDir,
  resolveHistoryFile,
  parseHistoryFile,
  discoverSessionId,
} from '../../src/agents/kimi/history';

// A real kimi-code 0.23.3 `wire.jsonl` shape (captured live 2026-07-09): a
// preamble (metadata / config.update), a `turn.prompt` (the user turn), the
// assistant's streamed `content.part` events — `think` (reasoning, skipped) then
// `text` (the reply) — plus tool call/result loop events (skipped).
function wire(): string {
  return [
    { type: 'metadata', protocol_version: '1.4', created_at: 1783560000000 },
    { type: 'config.update', profileName: 'agent', systemPrompt: 'You are Kimi.', time: 1783560000001 },
    { type: 'turn.prompt', input: [{ type: 'text', text: 'Reply with: The quick brown fox.' }], origin: 'user', time: 1783560000002 },
    { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>ignore me</system-reminder>' }] }, time: 1783560000003 },
    { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: 'The user wants an exact sentence.' } }, time: 1783560000004 },
    { type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 't1', name: 'Glob', args: {} }, time: 1783560000005 },
    { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 't1', result: { output: 'stuff' } }, time: 1783560000006 },
    { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'The quick ' } }, time: 1783560000007 },
    { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'brown fox.' } }, time: 1783560000008 },
    { type: 'usage.record', model: 'kimi-for-coding', usage: {}, time: 1783560000009 },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
}

describe('kimi/history parseHistoryFile', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('extracts the user turn + the accumulated assistant text, skipping think/tools/system-reminders', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'kimi-wire-'));
    dirs.push(tmp);
    const file = path.join(tmp, 'wire.jsonl');
    writeFileSync(file, wire());

    const msgs = parseHistoryFile(file);

    expect(msgs.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(msgs[0].text).toBe('Reply with: The quick brown fox.');
    // Streamed `text` parts are concatenated; `think` + tool events are skipped.
    expect(msgs[1].text).toBe('The quick brown fox.');
  });

  it('returns [] for a missing file', () => {
    expect(parseHistoryFile('/nope/wire.jsonl')).toEqual([]);
  });
});

describe('kimi/history resolveHistoryFile', () => {
  const homes: string[] = [];
  afterEach(() => {
    delete process.env.KIMI_CODE_HOME;
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  function seed(cwd: string, sessionId: string): { home: string; wireFile: string } {
    const home = mkdtempSync(path.join(tmpdir(), 'kimi-home-'));
    homes.push(home);
    process.env.KIMI_CODE_HOME = home;
    const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
    const bucket = path.join(home, 'sessions', `wd_${path.basename(cwd)}_${hash}`);
    const sessionDir = path.join(bucket, sessionId);
    const agentMain = path.join(sessionDir, 'agents', 'main');
    mkdirSync(agentMain, { recursive: true });
    const wireFile = path.join(agentMain, 'wire.jsonl');
    writeFileSync(wireFile, wire());
    writeFileSync(
      path.join(home, 'session_index.jsonl'),
      JSON.stringify({ sessionId, sessionDir, workDir: cwd }) + '\n',
    );
    return { home, wireFile };
  }

  it('resolves the wire.jsonl for a session via the computed wd_<key> bucket', () => {
    const cwd = '/workspaces/privacyhawk_webapp';
    const sessionId = 'session_da71a11c-ae2e-439f-a978-dccd5a14dda7';
    const { wireFile } = seed(cwd, sessionId);
    expect(resolveHistoryFile(cwd, sessionId)).toBe(wireFile);
    expect(resolveHistoryDir(cwd)).toContain('wd_privacyhawk_webapp_');
  });

  it('falls back to session_index.jsonl when the cwd encoding does not match', () => {
    // Seed under the real cwd, then query with a DIFFERENT cwd string: the
    // computed bucket won't match, so the index (authoritative) must win.
    const seededCwd = '/workspaces/privacyhawk_webapp';
    const sessionId = 'session_abc';
    const { wireFile } = seed(seededCwd, sessionId);
    expect(resolveHistoryFile('/some/other/path', sessionId)).toBe(wireFile);
  });

  it('returns null for an unknown session', () => {
    seed('/workspaces/x', 'session_known');
    expect(resolveHistoryFile('/workspaces/x', 'session_unknown')).toBeNull();
  });
});

describe('kimi/history discoverSessionId', () => {
  const homes: string[] = [];
  afterEach(() => {
    delete process.env.KIMI_CODE_HOME;
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  function bucketFor(cwd: string): string {
    const home = mkdtempSync(path.join(tmpdir(), 'kimi-home-'));
    homes.push(home);
    process.env.KIMI_CODE_HOME = home;
    const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
    const bucket = path.join(home, 'sessions', `wd_${path.basename(cwd)}_${hash}`);
    mkdirSync(bucket, { recursive: true });
    return bucket;
  }

  function makeSessionDir(bucket: string, id: string): string {
    const dir = path.join(bucket, id);
    mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), '');
    return dir;
  }

  it('discovers the freshly-created session dir (mtime ≥ spawn time)', async () => {
    const cwd = '/workspaces/privacyhawk_webapp';
    const bucket = bucketFor(cwd);
    // A stale session from a prior run — must NOT be picked.
    const stale = makeSessionDir(bucket, 'session_stale');
    const past = new Date(Date.now() - 60_000);
    require('node:fs').utimesSync(stale, past, past);
    // The session kimi mints at boot (mtime = now).
    makeSessionDir(bucket, 'session_fresh');

    const id = await discoverSessionId(cwd, { sinceMs: Date.now(), timeoutMs: 2_000 });
    expect(id).toBe('session_fresh');
  });

  it('returns null when no fresh session appears within the budget', async () => {
    const cwd = '/workspaces/empty';
    bucketFor(cwd); // bucket exists but is empty
    const id = await discoverSessionId(cwd, { sinceMs: Date.now(), timeoutMs: 500 });
    expect(id).toBeNull();
  });
});
