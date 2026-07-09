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
import { validateNonEmptyCredential } from '../strategy';
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
    validate: validateNonEmptyCredential,
  };
}

export function coderabbitLoginLauncher(os: OsStrategy): AgentLoginLauncher {
  return {
    async ensureInstalled(): Promise<boolean> {
      return ensureCoderabbitInstalled(os);
    },
    launch(): ChildProcess {
      // CodeRabbit's sign-in is `coderabbit auth login` (NOT `coderabbit
      // login` — that subcommand does not exist). It starts a local
      // loopback server and opens the browser to
      // `app.coderabbit.ai/login?client=cli&redirect_uri=http://127.0.0.1:<port>/callback`,
      // then captures the callback's `access_token` (a non-expiring,
      // opaque encrypted envelope) into `~/.coderabbit/`. Inherited stdio
      // lets the user complete the browser flow. (For the app-driven flow
      // the `--agent` variant streams JSON status events — see Phase 1.)
      return spawn('coderabbit', ['auth', 'login'], { stdio: 'inherit' });
    },
  };
}
