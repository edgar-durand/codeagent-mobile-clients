import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The user-level `CLAUDE.md` Claude Code will actually read. It lives in the
 * Claude config dir, which is `~/.claude` unless `CLAUDE_CONFIG_DIR` moves it —
 * and every house (CodeAgent) session DOES move it, to an isolated
 * `~/.codeam/house-claude/<deploy>` dir. Writing the Agent Standard and the
 * beads hint to `~/.claude/CLAUDE.md` there reached no agent: house sessions
 * ignored the phone-brevity rules (owner, 2026-09-25).
 *
 * An explicit `homeDir` (tests) always wins over the environment.
 */
export function claudeMemoryFile(homeDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (homeDir) return path.join(homeDir, '.claude', 'CLAUDE.md');
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? path.join(configDir, 'CLAUDE.md') : path.join(os.homedir(), '.claude', 'CLAUDE.md');
}
