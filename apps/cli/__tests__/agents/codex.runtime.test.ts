import { describe, it, expect } from 'vitest';
import { CodexRuntimeStrategy } from '../../src/agents/codex/runtime';

const runtime = new CodexRuntimeStrategy();

describe('CodexRuntimeStrategy', () => {
  it('reports id=codex and pulls meta from AGENT_REGISTRY', () => {
    expect(runtime.id).toBe('codex');
    expect(runtime.meta.binaryName).toBe('codex');
  });

  it('resumeLaunchArgs returns [resume, sessionId] (subcommand, not flag)', () => {
    expect(runtime.resumeLaunchArgs('sess-abc')).toEqual(['resume', 'sess-abc']);
  });

  it('does NOT define postSpawnInstruction (resume is a CLI subcommand)', () => {
    expect(runtime.postSpawnInstruction).toBeUndefined();
  });

  it('changeModelInstruction emits /model <id> PTY input', () => {
    expect(runtime.changeModelInstruction('gpt-5.4')).toEqual({
      type: 'pty',
      ptyInput: '/model gpt-5.4\r',
    });
  });

  it('summarizeInstruction(normal) returns /compact PTY input', () => {
    expect(runtime.summarizeInstruction('normal')).toEqual({ ptyInput: '/compact\r' });
  });

  it('summarizeInstruction(auto) falls through to /compact (Codex has no auto-compact)', () => {
    expect(runtime.summarizeInstruction('auto')).toEqual({ ptyInput: '/compact\r' });
  });

  it('listModels returns the 6 GPT-5.x models with 272K context window', async () => {
    const models = await runtime.listModels();
    const ids = models.map(m => m.id);
    expect(ids).toContain('gpt-5.5');
    expect(ids).toContain('gpt-5.3-codex');
    for (const m of models) {
      expect(m.contextWindow).toBe(272_000);
    }
  });

  it('fetchWeeklyUsage returns null (Codex /status is an RPC, not exposed yet)', async () => {
    await expect(runtime.fetchWeeklyUsage()).resolves.toBeNull();
  });

  it('getCurrentUsage returns null (Codex history.jsonl has no token data)', () => {
    expect(runtime.getCurrentUsage('/any/dir')).toBeNull();
  });
});
