/**
 * `codeam link aider` strategy.
 *
 * Aider has NO `aider login` subcommand — it reads model-provider
 * API keys from env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …)
 * at startup. The link flow uses the existing `--api-key=<key>` /
 * `--api-key-file=<path>` escape hatches in commands/link.ts when
 * `extractLocalAiderToken` returns null.
 *
 * `loginLauncher.launch()` prints guidance and returns a child that
 * exits immediately — the link command's `captureFreshCredentials`
 * loop then falls through to its "exited but no creds" path, which
 * we'd normally treat as failure. For Aider that's the expected
 * path: users WITHOUT env vars set up should always use --api-key
 * directly. We surface clearer guidance via the launcher's
 * `ensureInstalled`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  extractLocalAiderToken,
  aiderCredentialsPaths,
} from './local-token';
import type { OsStrategy } from '../../os';
import type {
  AgentCredentialLocator,
  AgentLoginLauncher,
} from '../strategy';

export function aiderCredentialLocator(): AgentCredentialLocator {
  return {
    publicId: 'aider',
    vendor: 'Aider',
    hint: 'ANTHROPIC_API_KEY / OPENAI_API_KEY env var or ~/.aider.conf.yml',
    watchPaths: aiderCredentialsPaths,
    extract: extractLocalAiderToken,
  };
}

export function aiderLoginLauncher(os: OsStrategy): AgentLoginLauncher {
  return {
    async ensureInstalled(): Promise<boolean> {
      if (os.findInPath('aider')) return true;
      console.error(
        '\n  ✗ aider binary not on PATH.\n' +
          '    Install Aider:\n' +
          '      pip install aider-chat\n' +
          '    then re-run `codeam link aider`.\n',
      );
      return false;
    },
    launch(): ChildProcess {
      // No real login flow. Echo guidance + exit so the link
      // command's child.on('exit') fires immediately and we fall
      // through to the timeout path. Users who DON'T already have
      // their API key set should run:
      //   codeam link aider --api-key=<key>
      // instead. This message is the breadcrumb to that.
      console.error(
        '\n  Aider has no interactive login flow.\n' +
          '    Set ANTHROPIC_API_KEY or OPENAI_API_KEY in your shell,\n' +
          '    or re-run `codeam link aider --api-key=<your-key>`.\n',
      );
      // `echo` is on every supported OS and exits 0. The link
      // command treats a clean exit as "no token written" and
      // surfaces a friendlier timeout error if the env var isn't
      // there either.
      return spawn(os.id === 'win32' ? 'cmd.exe' : 'sh', os.id === 'win32' ? ['/c', 'exit', '0'] : ['-c', 'exit 0'], {
        stdio: 'ignore',
      });
    },
  };
}
