/**
 * `codeam link codex` strategy — credential locator + sign-in
 * launcher for the OpenAI Codex CLI. Moved here from
 * `commands/link.ts`'s inline `AGENT_META` block (#56).
 *
 * Codex has no bundled installer (`ensureInstalled` surfaces a
 * clear error instead of attempting to install) and a proper
 * non-REPL `codex login` subcommand, so `launch()` spawns it
 * directly without piping.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  extractLocalCodexToken,
  codexCredentialsPaths,
} from './local-token';
import { createOsStrategy } from '../../os';
import type {
  AgentCredentialLocator,
  AgentLoginLauncher,
} from '../strategy';

export function codexCredentialLocator(): AgentCredentialLocator {
  return {
    publicId: 'codex',
    vendor: 'OpenAI',
    hint: '~/.codex/auth.json',
    watchPaths: codexCredentialsPaths,
    extract: extractLocalCodexToken,
  };
}

export function codexLoginLauncher(): AgentLoginLauncher {
  return {
    async ensureInstalled(): Promise<boolean> {
      // No bundled installer for Codex — surface a clear error when
      // the binary is missing instead of attempting a fragile
      // self-install path. The link command turns the false return
      // into a user-facing showError().
      const os = createOsStrategy();
      return os.findInPath('codex') !== null;
    },
    launch(): ChildProcess {
      return spawn('codex', ['login'], { stdio: 'inherit' });
    },
  };
}
