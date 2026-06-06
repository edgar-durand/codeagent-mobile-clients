/**
 * `codeam link gemini` — credential locator + login launcher for
 * Google's Gemini CLI.
 *
 * Gemini has a proper non-REPL `gemini auth login` subcommand that
 * opens a browser-based OAuth flow and writes `~/.gemini/oauth_creds.json`
 * (and/or the keychain on macOS). The launcher spawns it directly with
 * inherited stdio so the user can see the device-code URL and complete
 * the flow without our CLI muxing the output.
 *
 * The credential locator watches the JSON file; when `gemini` finishes
 * writing it, link.ts's chokidar watcher fires and the captured blob
 * is POSTed to /api/plugin/agents/gemini/link.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  extractLocalGeminiToken,
  geminiCredentialsPaths,
  validateLocalGeminiToken,
} from './local-token';
import { createOsStrategy } from '../../os';
import type {
  AgentCredentialLocator,
  AgentLoginLauncher,
  LocalAgentTokenValidation,
} from '../strategy';

export function geminiCredentialLocator(): AgentCredentialLocator {
  return {
    publicId: 'gemini',
    vendor: 'Google',
    hint: '~/.gemini/oauth_creds.json',
    watchPaths: geminiCredentialsPaths,
    extract: extractLocalGeminiToken,
    validate: (token): LocalAgentTokenValidation => {
      const result = validateLocalGeminiToken(token.credential);
      return { status: result.status, reason: result.reason };
    },
  };
}

export function geminiLoginLauncher(): AgentLoginLauncher {
  return {
    async ensureInstalled(): Promise<boolean> {
      // No bundled installer — Gemini CLI is `npm install -g @google/gemini-cli`.
      // We refuse to install on the user's machine without consent;
      // surface a clear error and let them re-run after install.
      const os = createOsStrategy();
      return os.findInPath('gemini') !== null;
    },
    launch(): ChildProcess {
      return spawn('gemini', ['auth', 'login'], { stdio: 'inherit' });
    },
  };
}
