import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Make a file owner-only (0600 on POSIX, ACL on Windows).
 *
 * POSIX: chmod 0o600.
 * Windows: icacls — remove inheritance, grant only the current user Full access.
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
        [filePath, '/inheritance:r', '/grant:r', `${username}:F`],
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
