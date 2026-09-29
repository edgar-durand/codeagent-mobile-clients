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
