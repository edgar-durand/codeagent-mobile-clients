/**
 * `codeam link claude` strategy — credential locator + sign-in
 * launcher for Claude Code. Moved here from
 * `commands/link.ts`'s inline `AGENT_META` block (#56) so adding
 * a new linkable agent is "new file + register" instead of
 * "edit a 50-line switch in the command layer."
 *
 * Behaviour intentionally matches the legacy AGENT_META["claude"]
 * entry byte-for-byte — chokidar watches, the `/login`
 * stdin-piped REPL, and ensureClaudeInstalled.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  extractLocalClaudeToken,
  claudeCredentialsPaths,
} from './local-token';
import { ensureClaudeInstalled } from './installer';
import type {
  AgentCredentialLocator,
  AgentLoginLauncher,
} from '../strategy';

export function claudeCredentialLocator(): AgentCredentialLocator {
  return {
    publicId: 'claude_code',
    vendor: 'Anthropic',
    hint: '~/.claude/.credentials.json or the macOS Keychain',
    watchPaths: claudeCredentialsPaths,
    extract: extractLocalClaudeToken,
  };
}

export function claudeLoginLauncher(): AgentLoginLauncher {
  return {
    ensureInstalled: ensureClaudeInstalled,
    launch(): ChildProcess {
      // Open the Claude REPL and pipe `/login` to its stdin so the
      // sign-in menu appears without the user having to type the
      // slash command themselves. `stdio: ['pipe', 'inherit',
      // 'inherit']` lets the user see Claude's UI + complete the
      // OAuth in their browser; the link command captures the
      // token via the file watcher running in parallel.
      const child = spawn('claude', [], { stdio: ['pipe', 'inherit', 'inherit'] });
      child.stdin?.write('/login\n');
      // Intentionally NOT closing stdin — the REPL stays interactive
      // so the user can finish any vendor prompts (paste-back code,
      // menu navigation) without their input being dropped.
      return child;
    },
  };
}
