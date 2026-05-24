/**
 * `codeam link coderabbit` strategy — credential locator + sign-in
 * launcher for CodeRabbit. Mirrors the shape of `agents/codex/link.ts`
 * because CodeRabbit's CLI auth flow is similar (a real `login`
 * subcommand that opens a browser).
 *
 * Credential storage path is `~/.coderabbit/auth.json` per the
 * CodeRabbit docs; the link command watches that path during the
 * sign-in subprocess and resolves as soon as the agent writes a
 * token.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureCoderabbitInstalled } from './installer';
import type { OsStrategy } from '../../os';
import type {
  AgentCredentialLocator,
  AgentLoginLauncher,
  LocalAgentToken,
} from '../strategy';

function authPath(): string {
  return path.join(os.homedir(), '.coderabbit', 'auth.json');
}

export async function extractLocalCoderabbitToken(): Promise<LocalAgentToken | null> {
  const file = authPath();
  if (!fs.existsSync(file)) return null;
  const credential = fs.readFileSync(file, 'utf8').trim();
  if (credential.length === 0) return null;
  return { method: 'oauth', credential, source: 'flat-file' };
}

export function coderabbitCredentialLocator(): AgentCredentialLocator {
  return {
    publicId: 'coderabbit',
    vendor: 'CodeRabbit',
    hint: '~/.coderabbit/auth.json',
    watchPaths: () => [authPath()],
    extract: extractLocalCoderabbitToken,
  };
}

export function coderabbitLoginLauncher(os: OsStrategy): AgentLoginLauncher {
  return {
    async ensureInstalled(): Promise<boolean> {
      return ensureCoderabbitInstalled(os);
    },
    launch(): ChildProcess {
      // CodeRabbit ships a real `coderabbit login` subcommand that
      // opens the browser; no REPL piping needed.
      return spawn('coderabbit', ['login'], { stdio: 'inherit' });
    },
  };
}
