import type { OsStrategy } from './strategy';
import { DarwinOsStrategy, LinuxOsStrategy } from './posix';
import { Win32OsStrategy } from './win32';

/**
 * Resolve the OsStrategy for the host. Lazy + memoised — the
 * platform isn't going to change while the process is alive, and
 * agent strategies / tests can re-use the same instance freely.
 *
 * For tests that need to exercise a non-native platform path, use
 * the per-class constructors directly:
 * `new Win32OsStrategy()` runs the Win32 logic on a macOS test
 * runner without affecting `process.platform` or other consumers.
 */
let cached: OsStrategy | null = null;

export function createOsStrategy(): OsStrategy {
  if (cached) return cached;
  cached = buildForPlatform(process.platform);
  return cached;
}

/**
 * Test-only escape hatch — clears the memo so a follow-up
 * `createOsStrategy()` re-evaluates `process.platform`. Production
 * code MUST NOT call this; the OS doesn't change at runtime.
 */
export function _resetOsStrategyCacheForTests(): void {
  cached = null;
}

function buildForPlatform(platform: NodeJS.Platform): OsStrategy {
  switch (platform) {
    case 'darwin':
      return new DarwinOsStrategy();
    case 'win32':
      return new Win32OsStrategy();
    default:
      // Linux is the documented third tier; freebsd / openbsd / sunos
      // all share enough POSIX surface that LinuxOsStrategy is a
      // safe-enough default. If a future user reports a real
      // divergence, we add a dedicated class — until then this
      // avoids gratuitously refusing to run.
      return new LinuxOsStrategy();
  }
}

export { DarwinOsStrategy, LinuxOsStrategy, Win32OsStrategy };
