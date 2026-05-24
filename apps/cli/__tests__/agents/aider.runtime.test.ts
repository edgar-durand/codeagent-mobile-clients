import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AiderRuntimeStrategy } from '../../src/agents/aider/runtime';
import { extractLocalAiderToken } from '../../src/agents/aider/local-token';
import {
  filterAiderChrome,
  parseAiderChrome,
} from '../../src/agents/aider/parsing';
import { LinuxOsStrategy } from '../../src/os';

describe('AiderRuntimeStrategy contract', () => {
  const runtime = new AiderRuntimeStrategy(new LinuxOsStrategy());

  it('reports mode="interactive" and id="aider"', () => {
    expect(runtime.mode).toBe('interactive');
    expect(runtime.id).toBe('aider');
    expect(runtime.meta.displayName).toBe('Aider');
    expect(runtime.meta.binaryName).toBe('aider');
  });

  it('supportedAuthKinds is api_key only (no OAuth)', () => {
    expect(runtime.meta.supportedAuthKinds).toEqual(['api_key']);
    expect(runtime.meta.preferredAuthKind).toBe('api_key');
  });

  it('resumeLaunchArgs uses --restore-chat-history (cwd-local history)', () => {
    expect(runtime.resumeLaunchArgs('sess-abc')).toEqual(['--restore-chat-history']);
  });

  it('listModels returns the curated representative subset', async () => {
    const models = await runtime.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain('claude-3-5-sonnet-20241022');
    expect(ids).toContain('gpt-4o');
  });

  it('summarizeInstruction emits /clear (Aider has no compact)', () => {
    expect(runtime.summarizeInstruction('normal')).toEqual({ ptyInput: '/clear\r' });
  });

  it('credentialLocator hint mentions env vars + config file', () => {
    const loc = runtime.credentialLocator();
    expect(loc.publicId).toBe('aider');
    expect(loc.hint).toMatch(/API_KEY/);
    expect(loc.hint).toMatch(/aider\.conf\.yml/);
  });

  it('prepareLaunch throws with pip install guidance when aider is missing', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/var/empty';
    try {
      await expect(runtime.prepareLaunch()).rejects.toThrow(/pip install aider-chat/);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe('aider/extractLocalAiderToken — env-var probing', () => {
  const ORIG_ANTHROPIC = process.env.ANTHROPIC_API_KEY;
  const ORIG_OPENAI = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  afterEach(() => {
    if (ORIG_ANTHROPIC !== undefined) process.env.ANTHROPIC_API_KEY = ORIG_ANTHROPIC;
    else delete process.env.ANTHROPIC_API_KEY;
    if (ORIG_OPENAI !== undefined) process.env.OPENAI_API_KEY = ORIG_OPENAI;
    else delete process.env.OPENAI_API_KEY;
  });

  it('returns null when no API key env var is set + no config file', async () => {
    const token = await extractLocalAiderToken();
    expect(token).toBeNull();
  });

  it('picks ANTHROPIC_API_KEY first when present', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const token = await extractLocalAiderToken();
    expect(token).toEqual({
      method: 'api_key',
      credential: 'sk-ant-test',
      source: 'flat-file',
    });
  });

  it('falls back to OPENAI_API_KEY when ANTHROPIC is absent', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    const token = await extractLocalAiderToken();
    expect(token?.credential).toBe('sk-openai-test');
  });

  it('ignores empty / whitespace-only values', async () => {
    process.env.ANTHROPIC_API_KEY = '   ';
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    const token = await extractLocalAiderToken();
    expect(token?.credential).toBe('sk-openai-test');
  });
});

describe('aider/parsing', () => {
  it('filterAiderChrome drops boot banner + status lines + spinners', () => {
    const lines = [
      'Aider v0.55.0',
      'Model: claude-3-5-sonnet',
      'Git repo: ./',
      'Repo-map: 1024 tokens',
      '',
      'Hello, here is my reply',
      '⠁ thinking',
      'Files added to chat: src/foo.ts',
      'Applied edit to src/foo.ts',
      'Commit a1b2c3d "fix foo"',
      'More agent prose here',
    ];
    const filtered = filterAiderChrome(lines);
    expect(filtered).toEqual(['Hello, here is my reply', 'More agent prose here']);
  });

  it('parseAiderChrome surfaces edit + commit as ChromeStep', () => {
    expect(parseAiderChrome('Applied edit to src/foo.ts')).toEqual({
      tool: 'edit',
      label: 'Applied edit',
      detail: 'src/foo.ts',
      status: 'done',
    });
    expect(parseAiderChrome('Committing changes...')).toEqual({
      tool: 'bash',
      label: 'git commit',
      status: 'running',
    });
    expect(parseAiderChrome('plain agent text')).toBeNull();
  });
});
