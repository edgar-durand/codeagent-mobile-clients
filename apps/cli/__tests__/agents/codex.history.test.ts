import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { realpathSync, utimesSync } from 'node:fs';
import {
  resolveHistoryDir,
  parseHistoryFile,
  getCurrentUsage,
  resolveHistoryFile,
  discoverSessionId,
  listResumableSessions,
} from '../../src/agents/codex/history';

/** Build today's UTC date-bucket dir under a fake ~/.codex/sessions home. */
function todayBucket(home: string): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return path.join(home, '.codex', 'sessions', yyyy, mm, dd);
}

describe('codex/history (rollouts)', () => {
  describe('resolveHistoryDir', () => {
    it('returns null when ~/.codex/sessions does not exist', () => {
      const fakeHome = path.join(tmpdir(), 'codex-h-nonexistent-' + Date.now());
      expect(resolveHistoryDir('/any/cwd', fakeHome)).toBeNull();
    });

    it("returns today's date bucket path when it exists", () => {
      const home = mkdtempSync(path.join(tmpdir(), 'codex-h-'));
      const now = new Date();
      const yyyy = String(now.getUTCFullYear());
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(now.getUTCDate()).padStart(2, '0');
      const dayDir = path.join(home, '.codex', 'sessions', yyyy, mm, dd);
      mkdirSync(dayDir, { recursive: true });
      expect(resolveHistoryDir('/any/cwd', home)).toBe(dayDir);
      rmSync(home, { recursive: true, force: true });
    });
  });

  describe('parseHistoryFile', () => {
    let origCwd: string;
    const dirsToClean: string[] = [];

    beforeEach(() => {
      origCwd = process.cwd();
    });
    afterEach(() => {
      // Restore cwd BEFORE rmSync — on Windows, `fs.rmSync(dir, …)`
      // throws EBUSY when `dir` is still the process cwd because the
      // OS keeps a handle on the current working directory. macOS /
      // Linux are lenient about this so the bug only surfaces in CI.
      process.chdir(origCwd);
      while (dirsToClean.length > 0) {
        const d = dirsToClean.pop()!;
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });

    it('emits user + assistant messages from response_item records', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-rollout-'));
      dirsToClean.push(dir);
      process.chdir(dir);

      const filePath = path.join(dir, 'rollout-2025-05-07T17-24-21-abc.jsonl');
      const lines = [
        JSON.stringify({
          timestamp: '2025-05-07T17:24:21.000Z',
          type: 'session_meta',
          payload: { id: 'sess1', cwd: dir, timestamp: '2025-05-07T17:24:21.000Z' },
        }),
        JSON.stringify({
          timestamp: '2025-05-07T17:24:22.000Z',
          type: 'response_item',
          payload: { Message: { role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
        }),
        JSON.stringify({
          timestamp: '2025-05-07T17:24:23.000Z',
          type: 'response_item',
          payload: {
            Message: {
              role: 'assistant',
              content: [{ type: 'output_text', text: 'hello back' }],
            },
          },
        }),
      ];
      writeFileSync(filePath, lines.join('\n'));

      const out = parseHistoryFile(filePath);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ id: 'rollout:0', role: 'user', text: 'hi' });
      expect(out[1]).toMatchObject({ id: 'rollout:1', role: 'agent', text: 'hello back' });
      expect(out[0].timestamp).toBe('2025-05-07T17:24:22.000Z');
    });

    it('parses the CURRENT flat payload format and filters synthetic turns (baton mirror)', () => {
      // Codex switched from the Rust-enum `{Message:{…}}` to a flat
      // `{type:'message', role, content}` payload (captured from a real
      // 2026-06 rollout). The old Message-only lookup dropped everything, so
      // the codex baton mirror showed nothing. The parser must read the flat
      // shape AND skip Codex's synthetic developer / environment / turn-aborted
      // injections — only the real user+assistant turns reach the phone.
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-flat-'));
      dirsToClean.push(dir);
      process.chdir(dir);

      const filePath = path.join(dir, 'rollout-2026-06-22T11-12-40-flat.jsonl');
      const rec = (type: string, payload: unknown): string =>
        JSON.stringify({ timestamp: '2026-06-22T11:12:40.000Z', type, payload });
      const flatMsg = (role: string, text: string): unknown => ({
        type: 'message',
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
      });
      writeFileSync(
        filePath,
        [
          rec('session_meta', { id: 'sess-flat', cwd: dir }),
          rec('response_item', flatMsg('developer', 'You are Codex. <permissions>…</permissions>')),
          rec(
            'response_item',
            flatMsg('user', '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>'),
          ),
          rec('response_item', flatMsg('user', 'hello')),
          rec('response_item', flatMsg('assistant', 'Hello. What would you like to work on?')),
          rec('response_item', flatMsg('user', '<turn_aborted> The user interrupted')),
        ].join('\n'),
      );

      const out = parseHistoryFile(filePath);
      expect(out.map((m) => [m.role, m.text])).toEqual([
        ['user', 'hello'],
        ['agent', 'Hello. What would you like to work on?'],
      ]);
    });

    it('drops a leaked codeam://squad-context resource block AND a <recommended_plugins> meta block (fleet-1 2026-08-13)', () => {
      // Real codex-acp rollout shape (captured from the incident): the bridge
      // downgrades our `resource` prompt block to a plain `input_text` item
      // whose text STARTS with the resource's own uri, and codex separately
      // injects its own `<recommended_plugins>` config block as a `user`-role
      // message — neither is something the user typed. Only the genuine
      // 'start the server' turn (and codex's reply) should survive.
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-leak-'));
      dirsToClean.push(dir);
      process.chdir(dir);

      const filePath = path.join(dir, 'rollout-2026-08-13T09-00-00-leak.jsonl');
      const rec = (type: string, payload: unknown): string =>
        JSON.stringify({ timestamp: '2026-08-13T09:00:00.000Z', type, payload });
      const flatMsg = (role: string, text: string): unknown => ({
        type: 'message',
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
      });
      const leakedResourceText =
        'codeam://squad-context <context resource text="[Team context] You are the active agent…">';
      const recommendedPlugins = [
        '<recommended_plugins>',
        '  - openai/curated-remote-plugin-a',
        '  - openai/curated-remote-plugin-b',
        '</recommended_plugins>',
      ].join('\n');
      writeFileSync(
        filePath,
        [
          rec('session_meta', { id: 'sess-leak', cwd: dir }),
          rec('response_item', flatMsg('user', leakedResourceText)),
          rec('response_item', flatMsg('user', recommendedPlugins)),
          rec('response_item', flatMsg('user', 'start the server')),
          rec('response_item', flatMsg('assistant', 'Starting it now.')),
        ].join('\n'),
      );

      const out = parseHistoryFile(filePath);
      expect(out.map((m) => [m.role, m.text])).toEqual([
        ['user', 'start the server'],
        ['agent', 'Starting it now.'],
      ]);
      expect(JSON.stringify(out)).not.toContain('codeam://squad-context');
      expect(JSON.stringify(out)).not.toContain('recommended_plugins');
    });

    it('returns [] when session_meta.cwd does not match process.cwd()', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-rollout-'));
      const wrongCwd = mkdtempSync(path.join(tmpdir(), 'codex-other-'));
      dirsToClean.push(dir, wrongCwd);
      process.chdir(dir);

      const filePath = path.join(dir, 'rollout.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify({
            timestamp: '2025-05-07T17:24:21.000Z',
            type: 'session_meta',
            payload: { cwd: wrongCwd },
          }),
          JSON.stringify({
            timestamp: '2025-05-07T17:24:22.000Z',
            type: 'response_item',
            payload: {
              Message: { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
            },
          }),
        ].join('\n'),
      );

      expect(parseHistoryFile(filePath)).toEqual([]);
    });

    it('skips non-Message response_item variants (tool calls, reasoning)', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-rollout-'));
      dirsToClean.push(dir);
      process.chdir(dir);

      const filePath = path.join(dir, 'rollout.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify({
            timestamp: '2025-05-07T17:24:21.000Z',
            type: 'session_meta',
            payload: { cwd: dir },
          }),
          JSON.stringify({
            timestamp: '2025-05-07T17:24:22.000Z',
            type: 'response_item',
            payload: { FunctionCall: { name: 'shell', args: '...' } },
          }),
          JSON.stringify({
            timestamp: '2025-05-07T17:24:23.000Z',
            type: 'response_item',
            payload: { Reasoning: { content: 'thinking...' } },
          }),
          JSON.stringify({
            timestamp: '2025-05-07T17:24:24.000Z',
            type: 'response_item',
            payload: {
              Message: {
                role: 'assistant',
                content: [{ type: 'output_text', text: 'done' }],
              },
            },
          }),
        ].join('\n'),
      );

      const out = parseHistoryFile(filePath);
      expect(out).toHaveLength(1);
      expect(out[0].text).toBe('done');
    });

    it('skips malformed JSON lines', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-rollout-'));
      dirsToClean.push(dir);
      process.chdir(dir);

      const filePath = path.join(dir, 'rollout.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify({
            timestamp: '2025-05-07T17:24:21.000Z',
            type: 'session_meta',
            payload: { cwd: dir },
          }),
          'not json at all',
          JSON.stringify({
            timestamp: '2025-05-07T17:24:22.000Z',
            type: 'response_item',
            payload: {
              Message: { role: 'user', content: [{ type: 'input_text', text: 'keep me' }] },
            },
          }),
        ].join('\n'),
      );

      const out = parseHistoryFile(filePath);
      expect(out).toHaveLength(1);
      expect(out[0].text).toBe('keep me');
    });
  });

  describe('resolveHistoryFile', () => {
    const dirsToClean: string[] = [];
    afterEach(() => {
      while (dirsToClean.length > 0) {
        const d = dirsToClean.pop()!;
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });

    function seedRollout(home: string, fileName: string, id: string, cwd: string): string {
      const bucket = todayBucket(home);
      mkdirSync(bucket, { recursive: true });
      const filePath = path.join(bucket, fileName);
      writeFileSync(
        filePath,
        [
          JSON.stringify({
            timestamp: '2025-05-07T17:24:21.000Z',
            type: 'session_meta',
            payload: { id, cwd, timestamp: '2025-05-07T17:24:21.000Z' },
          }),
          JSON.stringify({
            timestamp: '2025-05-07T17:24:22.000Z',
            type: 'response_item',
            payload: { Message: { role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
          }),
        ].join('\n'),
      );
      return filePath;
    }

    it('returns null when ~/.codex/sessions does not exist', () => {
      const fakeHome = path.join(tmpdir(), 'codex-rhf-none-' + Date.now());
      expect(resolveHistoryFile('/any/cwd', 'sess1', fakeHome)).toBeNull();
    });

    it('returns the rollout path whose session_meta.id matches (for this cwd)', () => {
      const home = mkdtempSync(path.join(tmpdir(), 'codex-rhf-'));
      const proj = mkdtempSync(path.join(tmpdir(), 'codex-proj-'));
      dirsToClean.push(home, proj);
      const expected = seedRollout(home, 'rollout-a.jsonl', 'sess-target', realpathSync(proj));

      expect(resolveHistoryFile(proj, 'sess-target', home)).toBe(expected);
    });

    it('returns null when no rollout carries the requested id', () => {
      const home = mkdtempSync(path.join(tmpdir(), 'codex-rhf-'));
      const proj = mkdtempSync(path.join(tmpdir(), 'codex-proj-'));
      dirsToClean.push(home, proj);
      seedRollout(home, 'rollout-a.jsonl', 'sess-other', realpathSync(proj));

      expect(resolveHistoryFile(proj, 'sess-missing', home)).toBeNull();
    });

    it('does NOT match a same-id rollout from a different project cwd (isolation)', () => {
      const home = mkdtempSync(path.join(tmpdir(), 'codex-rhf-'));
      const proj = mkdtempSync(path.join(tmpdir(), 'codex-proj-'));
      const otherProj = mkdtempSync(path.join(tmpdir(), 'codex-other-'));
      dirsToClean.push(home, proj, otherProj);
      // Rollout with the right id but recorded under a DIFFERENT cwd.
      seedRollout(home, 'rollout-a.jsonl', 'sess-x', realpathSync(otherProj));

      expect(resolveHistoryFile(proj, 'sess-x', home)).toBeNull();
    });
  });

  describe('listResumableSessions — summary/title never latches on a leaked or meta block', () => {
    const dirsToClean: string[] = [];
    afterEach(() => {
      while (dirsToClean.length > 0) {
        try {
          rmSync(dirsToClean.pop()!, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });

    it('skips the leaked squad-context text AND the <recommended_plugins> block, using the first REAL user message as the title', () => {
      const home = mkdtempSync(path.join(tmpdir(), 'codex-list-leak-'));
      const proj = mkdtempSync(path.join(tmpdir(), 'codex-proj-'));
      dirsToClean.push(home, proj);
      const cwd = realpathSync(proj);
      const bucket = todayBucket(home);
      mkdirSync(bucket, { recursive: true });

      const rec = (type: string, payload: unknown): string =>
        JSON.stringify({ timestamp: '2026-08-13T09:00:00.000Z', type, payload });
      const flatMsg = (role: string, text: string): unknown => ({
        type: 'message',
        role,
        content: [{ type: 'input_text', text }],
      });
      const leakedResourceText = 'codeam://squad-context <context resource text="…">';
      const recommendedPlugins = '<recommended_plugins>\n  - a\n</recommended_plugins>';

      const filePath = path.join(bucket, 'rollout-2026-08-13T09-00-00-leak.jsonl');
      writeFileSync(
        filePath,
        [
          rec('session_meta', { id: 'sess-leak', cwd }),
          rec('response_item', flatMsg('user', leakedResourceText)),
          rec('response_item', flatMsg('user', recommendedPlugins)),
          rec('response_item', flatMsg('user', 'deploy the codespace agent')),
        ].join('\n'),
      );

      const sessions = listResumableSessions(cwd, home);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('sess-leak');
      expect(sessions[0].summary).toBe('deploy the codespace agent');
    });
  });

  describe('getCurrentUsage', () => {
    it('returns null when no rollout files in dir', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-no-rollouts-'));
      expect(getCurrentUsage(dir)).toBeNull();
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns last TokenCount info from newest rollout', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-rollout-'));
      const filePath = path.join(dir, 'rollout-1.jsonl');
      writeFileSync(
        filePath,
        [
          JSON.stringify({
            timestamp: '2025-05-07T17:24:21.000Z',
            type: 'event_msg',
            payload: {
              TokenCount: {
                info: {
                  total_token_usage: { total_tokens: 10_000 },
                  model_context_window: 272_000,
                },
              },
            },
          }),
          JSON.stringify({
            timestamp: '2025-05-07T17:24:22.000Z',
            type: 'event_msg',
            payload: {
              TokenCount: {
                info: {
                  total_token_usage: { total_tokens: 50_000 },
                  model_context_window: 272_000,
                },
              },
            },
          }),
        ].join('\n'),
      );

      const usage = getCurrentUsage(dir);
      expect(usage).toEqual({ used: 50_000, total: 272_000, percent: 18 });
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('discoverSessionId (baton)', () => {
    const dirsToClean: string[] = [];
    afterEach(() => {
      while (dirsToClean.length > 0) {
        try {
          rmSync(dirsToClean.pop()!, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });

    function seedRollout(home: string, id: string, cwd: string): string {
      const bucket = todayBucket(home);
      mkdirSync(bucket, { recursive: true });
      const filePath = path.join(bucket, `rollout-2026-07-09T00-00-00-${id}.jsonl`);
      writeFileSync(
        filePath,
        JSON.stringify({
          timestamp: '2026-07-09T00:00:00.000Z',
          type: 'session_meta',
          payload: { id, cwd },
        }),
      );
      return filePath;
    }

    it("discovers the fresh rollout's id for this cwd (mtime ≥ sinceMs)", async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'codex-disc-'));
      const proj = mkdtempSync(path.join(tmpdir(), 'codex-proj-'));
      dirsToClean.push(home, proj);
      const cwd = realpathSync(proj);
      // A stale rollout from a prior session — must NOT be picked.
      const stale = seedRollout(home, 'sess-stale', cwd);
      const past = new Date(Date.now() - 60_000);
      utimesSync(stale, past, past);
      // The rollout codex just wrote on the first turn (mtime = now).
      seedRollout(home, 'sess-fresh', cwd);

      const id = await discoverSessionId(cwd, { sinceMs: Date.now(), timeoutMs: 1_000 }, home);
      expect(id).toBe('sess-fresh');
    });

    it('ignores a fresh rollout belonging to a DIFFERENT cwd', async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'codex-disc-'));
      const proj = mkdtempSync(path.join(tmpdir(), 'codex-proj-'));
      const other = mkdtempSync(path.join(tmpdir(), 'codex-other-'));
      dirsToClean.push(home, proj, other);
      seedRollout(home, 'sess-other', realpathSync(other));

      const id = await discoverSessionId(
        realpathSync(proj),
        { sinceMs: Date.now(), timeoutMs: 600 },
        home,
      );
      expect(id).toBeNull();
    });

    it('returns null when no fresh rollout appears within the budget', async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'codex-disc-'));
      const proj = mkdtempSync(path.join(tmpdir(), 'codex-proj-'));
      dirsToClean.push(home, proj);
      const id = await discoverSessionId(
        realpathSync(proj),
        { sinceMs: Date.now(), timeoutMs: 600 },
        home,
      );
      expect(id).toBeNull();
    });
  });
});
