import { describe, it, expect } from 'vitest';
import { ClaudeRuntimeStrategy } from '../../src/agents/claude/runtime';

const runtime = new ClaudeRuntimeStrategy();

describe('ClaudeRuntimeStrategy', () => {
  it('reports id=claude and pulls meta from AGENT_REGISTRY', () => {
    expect(runtime.id).toBe('claude');
    expect(runtime.meta.binaryName).toBe('claude');
    expect(runtime.meta.displayName).toBe('Claude Code');
  });

  it('resumeLaunchArgs returns --resume + --dangerously-skip-permissions', () => {
    expect(runtime.resumeLaunchArgs('sess-abc')).toEqual([
      '--resume',
      'sess-abc',
      '--dangerously-skip-permissions',
    ]);
  });

  it('does NOT define postSpawnInstruction (Claude uses CLI flag, not in-TUI)', () => {
    // Access via interface type to avoid TS2339 — the optional method
    // is not declared on the concrete class, which is the correct shape.
    const strategy: import('../../src/agents/strategy').RuntimeStrategy = runtime;
    expect(strategy.postSpawnInstruction).toBeUndefined();
  });

  it('changeModelInstruction returns a PTY input for /model', () => {
    expect(runtime.changeModelInstruction('claude-opus-4-7')).toEqual({
      type: 'pty',
      ptyInput: '/model claude-opus-4-7\r',
    });
  });

  it('summarizeInstruction(normal) returns /compact', () => {
    expect(runtime.summarizeInstruction('normal')).toEqual({ ptyInput: '/compact\r' });
  });

  it('summarizeInstruction(auto) returns a /compact PTY input', () => {
    // Open question §10.3 — placeholder; will be refined when "AUTO" syntax confirmed
    const r = runtime.summarizeInstruction('auto');
    expect(r.ptyInput).toMatch(/\/compact/);
  });

  it('listModels returns the static Claude catalog', async () => {
    const models = await runtime.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain('claude-opus-4-7');
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('claude-haiku-4-5-20251001');
  });

  it('listModels each entry has contextWindow', async () => {
    const models = await runtime.listModels();
    for (const m of models) {
      expect(m.contextWindow).toBeGreaterThan(0);
    }
  });

  it('resolveHistoryDir delegates to claude/history', () => {
    // Smoke: it should at least not throw for non-existent paths
    expect(runtime.resolveHistoryDir('/non/existent/cwd')).toBeNull();
  });
});
