import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryService } from '../src/services/history.service';
import { encodeCwd, resolveHistoryDir } from '../src/agents/claude/history';
import { claudeConfigDir } from '../src/agents/claude-memory-file';
import type { RuntimeStrategy } from '../src/agents/strategy';

/**
 * A managed / house session runs Claude with CLAUDE_CONFIG_DIR pointing at
 * `~/.codeam/house-claude/<deploy>`, so its transcripts live under THAT
 * `projects/` dir. Looking in `~/.claude/projects` found nothing: the
 * session-start upload answered false and a woken Box opened an empty
 * conversation over the resumed one (2026-09-29).
 */
describe('transcripts honour CLAUDE_CONFIG_DIR', () => {
  const cwd = '/home/box/.codeam/self-hosted/deploy-1';
  let cfg: string;
  const prev = process.env.CLAUDE_CONFIG_DIR;
  beforeEach(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-cfg-'));
    process.env.CLAUDE_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(cfg, { recursive: true, force: true });
  });

  it('claudeConfigDir follows the env var and falls back to ~/.claude', () => {
    expect(claudeConfigDir()).toBe(cfg);
    expect(claudeConfigDir({})).toBe(path.join(os.homedir(), '.claude'));
  });

  it('HistoryService finds a house session transcript under the config dir', async () => {
    const dir = path.join(cfg, 'projects', encodeCwd(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const SID = 'ce235130-1a1a-420f-adae-3fd23ad8011c';
    fs.writeFileSync(
      path.join(dir, `${SID}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-09-29T00:00:00Z',
        message: { role: 'user', content: 'hi' },
      }) + '\n',
    );
    const runtime = { id: 'claude', resolveHistoryDir: () => null } as unknown as RuntimeStrategy;
    const svc = new HistoryService(runtime, 'plugin-1', cwd);
    // The private resolver is what gates the upload; a found file is the proof.
    const resolved = (
      svc as unknown as { resolveConversationFile: (id: string) => string | null }
    ).resolveConversationFile(SID);
    expect(resolved).toBe(path.join(dir, `${SID}.jsonl`));
    expect(fs.existsSync(resolved as string)).toBe(true);
  });

  it('resolveHistoryDir reads the same root', () => {
    const dir = path.join(cfg, 'projects', encodeCwd(cwd));
    fs.mkdirSync(dir, { recursive: true });
    expect(resolveHistoryDir(cwd)).toBe(dir);
  });
});

describe('detectCurrentConversation skips one-shot transcripts', () => {
  const cwd = '/home/box/.codeam/self-hosted/deploy-2';
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  const prevHome = process.env.HOME;
  afterEach(() => {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    process.env.HOME = prevHome;
  });

  it('a newer registered one-shot never becomes the current conversation', async () => {
    const { registerOneShotConversation } = await import('../src/services/oneshot-registry');
    process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-cfg-'));
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-home-'));
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', encodeCwd(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const USER = 'aaaaaaaa-0000-0000-0000-000000000001';
    const ONE_SHOT = 'bbbbbbbb-0000-0000-0000-000000000002';
    const runtime = { id: 'claude', resolveHistoryDir: () => null } as unknown as RuntimeStrategy;
    const svc = new HistoryService(runtime, 'plugin-1', cwd, { bootTimeMs: Date.now() });
    fs.writeFileSync(path.join(dir, `${USER}.jsonl`), '{}\n');
    const later = new Date(Date.now() + 10_000);
    fs.writeFileSync(path.join(dir, `${ONE_SHOT}.jsonl`), '{}\n');
    fs.utimesSync(path.join(dir, `${ONE_SHOT}.jsonl`), later, later);
    registerOneShotConversation(cwd, ONE_SHOT);

    svc.detectCurrentConversation();
    expect(svc.getCurrentConversationId()).toBe(USER);
  });
});

/**
 * codeagent-ikuj: an in-session switch_agent to a managed/house agent spawns
 * Claude with `~/.codeam/house-claude/switch-<pluginId>` as CLAUDE_CONFIG_DIR
 * ONLY in the adapter's extraEnv (recorded via setCurrentAgentEnv); the CLI's
 * process.env keeps the deploy-time dir. Transcript resolution must follow the
 * agent that is actually running.
 */
describe('transcripts follow the CURRENT agent env after an in-session switch', () => {
  const cwd = '/home/box/.codeam/self-hosted/deploy-3';
  const prev = process.env.CLAUDE_CONFIG_DIR;
  let deployDir: string;
  let switchDir: string;
  beforeEach(async () => {
    deployDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-deploy-cfg-'));
    switchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-switch-cfg-'));
    process.env.CLAUDE_CONFIG_DIR = deployDir;
    fs.mkdirSync(path.join(deployDir, 'projects', encodeCwd(cwd)), { recursive: true });
    fs.mkdirSync(path.join(switchDir, 'projects', encodeCwd(cwd)), { recursive: true });
  });
  afterEach(async () => {
    const { resetCurrentAgentEnvForTests } = await import('../src/agents/current-agent-env');
    resetCurrentAgentEnvForTests();
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(deployDir, { recursive: true, force: true });
    fs.rmSync(switchDir, { recursive: true, force: true });
  });

  it('resolves under the switched agent config dir, and back after a revert', async () => {
    const { setCurrentAgentEnv } = await import('../src/agents/current-agent-env');
    setCurrentAgentEnv({ CLAUDE_CONFIG_DIR: switchDir });
    expect(claudeConfigDir()).toBe(switchDir);
    expect(resolveHistoryDir(cwd)).toBe(path.join(switchDir, 'projects', encodeCwd(cwd)));

    const SID = 'dddddddd-0000-0000-0000-000000000004';
    fs.writeFileSync(path.join(switchDir, 'projects', encodeCwd(cwd), `${SID}.jsonl`), '{}\n');
    const runtime = { id: 'claude', resolveHistoryDir: () => null } as unknown as RuntimeStrategy;
    const svc = new HistoryService(runtime, 'plugin-1', cwd);
    const resolved = (
      svc as unknown as { resolveConversationFile: (id: string) => string | null }
    ).resolveConversationFile(SID);
    expect(resolved).toBe(path.join(switchDir, 'projects', encodeCwd(cwd), `${SID}.jsonl`));

    // Revert / switch back to a BYO agent: the relaunch records an overlay with
    // no config-dir override → the deploy-time dir again.
    setCurrentAgentEnv({});
    expect(claudeConfigDir()).toBe(deployDir);
  });

  it('a switch AWAY from a house deploy (CLAUDE_CONFIG_DIR cleared) resolves ~/.claude', async () => {
    const { setCurrentAgentEnv } = await import('../src/agents/current-agent-env');
    setCurrentAgentEnv({ CLAUDE_CONFIG_DIR: undefined });
    expect(claudeConfigDir()).toBe(path.join(os.homedir(), '.claude'));
  });
});
