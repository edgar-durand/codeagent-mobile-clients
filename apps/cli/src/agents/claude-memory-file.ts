import * as os from 'node:os';
import * as path from 'node:path';
import { currentAgentEnv } from './current-agent-env';

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
  return path.join(claudeConfigDir(env), 'CLAUDE.md');
}

/**
 * Claude Code's config dir: `CLAUDE_CONFIG_DIR` when set (every managed /
 * house session runs with its own `~/.codeam/house-claude/<deploy>`), else
 * `~/.claude`. Transcripts live under `<configDir>/projects/<encoded cwd>/`.
 *
 * ⚠️ Defaults to the CURRENT agent's env, not the frozen `process.env`: an
 * in-session `switch_agent` to a managed/house agent spawns Claude with its own
 * `~/.codeam/house-claude/switch-<pluginId>` (and a switch AWAY from a house
 * deploy clears it) only in the adapter's extraEnv, so transcript lookups that
 * read `process.env` looked in the config dir the session STARTED with and
 * never found the switched agent's JSONL (codeagent-ikuj).
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = currentAgentEnv()): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? configDir : path.join(os.homedir(), '.claude');
}
