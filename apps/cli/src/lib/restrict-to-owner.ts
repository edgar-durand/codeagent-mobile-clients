import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Broad principals that must NOT hold an ACE on an owner-only file, as
 * locale-independent well-known SIDs (`icacls` accepts the `*SID` form):
 * Everyone, Authenticated Users, BUILTIN\Users, BUILTIN\Administrators,
 * NT AUTHORITY\SYSTEM.
 */
const BROAD_WINDOWS_SIDS = [
  '*S-1-1-0',
  '*S-1-5-11',
  '*S-1-5-32-545',
  '*S-1-5-32-544',
  '*S-1-5-18',
] as const;

/**
 * Make a file owner-only (0600 on POSIX, ACL on Windows).
 *
 * POSIX: chmod 0o600.
 * Windows: icacls — remove inheritance, grant only the current user Full
 * access, and EXPLICITLY remove every broad principal. The explicit
 * `/remove` set is load-bearing: a file created under the user profile can
 * carry SYSTEM / BUILTIN\Administrators as EXPLICIT (non-inherited) ACEs —
 * observed on GitHub's windows-latest runners, where they appear with no
 * `(I)` flag — and `/inheritance:r` only strips INHERITED ACEs, so without
 * the removes the broad ACEs survive and the file is not owner-only. Same
 * posture as OpenSSH-on-Windows takes for ~/.ssh keys.
 *
 * Best-effort on BOTH platforms: any failure (icacls non-zero, a chmod on a
 * read-only FS, or a race where the file vanished after rename) is caught and
 * never propagates — restricting permissions must NEVER break the file write
 * it follows.
 */
export function restrictToOwner(filePath: string): void {
  try {
    if (process.platform === 'win32') {
      const username = os.userInfo().username;
      execFileSync(
        'icacls',
        [
          filePath,
          '/inheritance:r',
          '/grant:r',
          `${username}:F`,
          ...BROAD_WINDOWS_SIDS.flatMap((sid) => ['/remove', sid]),
        ],
        { stdio: 'ignore' },
      );
    } else {
      fs.chmodSync(filePath, 0o600);
    }
  } catch {
    // best-effort on both platforms — never break the caller
  }
}

/**
 * Returns true iff `filePath` is accessible only by the current owner.
 *
 * POSIX: mode bits must be exactly 0o600.
 * Windows: run `icacls <file>` and verify no broad principals appear in the ACL
 *          (BUILTIN\Users, Everyone, Authenticated Users, NT AUTHORITY\...).
 *          Uses absence-of-broad-groups rather than exact match (tolerant parse).
 */
export function isOwnerOnly(filePath: string): boolean {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('icacls', [filePath], { encoding: 'utf8' });
      // Broad principals that indicate the file is NOT owner-only:
      const broadPrincipals = [
        'Everyone',
        'Authenticated Users',
        'BUILTIN\\Users',
        'BUILTIN\\Administrators',
        'NT AUTHORITY\\',
      ];
      return !broadPrincipals.some((p) => out.includes(p));
    } catch {
      return false;
    }
  } else {
    try {
      return (fs.statSync(filePath).mode & 0o777) === 0o600;
    } catch {
      return false;
    }
  }
}
