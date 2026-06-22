/**
 * `codeam link cursor` strategy.
 *
 * Cursor ships a real `cursor-agent login` subcommand, so the launch
 * is identical in shape to codex (no REPL piping). `ensureInstalled`
 * just probes PATH — Cursor doesn't provide a public install script
 * we can curl; users are expected to install via Cursor's own
 * desktop installer first. We surface a clear error when the binary
 * isn't on PATH instead of attempting a fragile bash workaround.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  extractLocalCursorToken,
  cursorCredentialsPaths,
} from './local-token';
import type { OsStrategy } from '../../os';
import { validateNonEmptyCredential } from '../strategy';
import type {
  AgentCredentialLocator,
  AgentLoginLauncher,
} from '../strategy';

export function cursorCredentialLocator(): AgentCredentialLocator {
  return {
    publicId: 'cursor',
    vendor: 'Cursor',
    hint: '~/.cursor/auth.json',
    watchPaths: cursorCredentialsPaths,
    extract: extractLocalCursorToken,
    validate: validateNonEmptyCredential,
  };
}

export function cursorLoginLauncher(os: OsStrategy): AgentLoginLauncher {
  return {
    async ensureInstalled(): Promise<boolean> {
      if (os.findInPath('cursor-agent')) return true;
      console.error(
        '\n  ✗ cursor-agent binary not on PATH.\n' +
          '    Install Cursor (https://cursor.com/) and ensure the CLI\n' +
          '    plugin is enabled, then re-run `codeam link cursor`.\n',
      );
      return false;
    },
    launch(): ChildProcess {
      return spawn('cursor-agent', ['login'], { stdio: 'inherit' });
    },
  };
}
