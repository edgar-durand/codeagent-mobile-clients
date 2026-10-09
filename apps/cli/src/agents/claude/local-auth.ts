import { execFile } from 'node:child_process';
import type { OsStrategy } from '../../os';
import type { LocalAuthState } from '../strategy';

/**
 * Read `claude auth status` output. Claude prints a JSON object with
 * `loggedIn` (true for a claude.ai login AND for an `ANTHROPIC_API_KEY` in the
 * env), and exits 1 when signed out (verified on claude 2.1.292). Anything we
 * can't read is `'unknown'`, never "signed out".
 */
export function parseClaudeAuthStatus(stdout: string): LocalAuthState {
  const start = stdout.indexOf('{');
  if (start < 0) return 'unknown';
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    if (typeof parsed !== 'object' || parsed === null || !('loggedIn' in parsed)) return 'unknown';
    if (parsed.loggedIn === true) return 'signed_in';
    if (parsed.loggedIn === false) return 'not_signed_in';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Ask the local `claude` whether it is signed in. Bounded; never throws. */
export function probeClaudeLocalAuth(
  os: Pick<OsStrategy, 'findInPath'>,
  timeoutMs = 10_000,
): Promise<LocalAuthState> {
  const bin = os.findInPath('claude') ?? os.findInPath('claude-code');
  if (!bin) return Promise.resolve('unknown');
  return new Promise((resolve) => {
    try {
      // A non-zero exit is the signed-out answer, so read stdout whatever the
      // exit code; only a spawn failure or a timeout leaves stdout empty.
      execFile(bin, ['auth', 'status'], { timeout: timeoutMs }, (_err, stdout) => {
        resolve(parseClaudeAuthStatus(String(stdout ?? '')));
      });
    } catch {
      resolve('unknown');
    }
  });
}
