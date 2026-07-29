/**
 * Stale npm staging-dir sweep before a CLI self-update (Rafael 2026-07-27).
 *
 * Three pair-auto children of ONE warm codespace fired concurrent
 * `npm i -g codeam-cli@latest` against the shared /usr/local prefix; the race
 * left a `.codeam-cli-<hash>` staging dir that made npm's rename fail with
 * `ENOTEMPTY`, wedging the self-update AND every "Retry". The pre-install sweep
 * clears such leftovers — but only STALE ones, so a concurrent in-flight
 * sibling install's fresh staging dir is never disturbed.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  resolveGlobalNodeModulesDir,
  sweepStaleCliStagingDirs,
} from '../../../src/commands/start/handlers';

describe('resolveGlobalNodeModulesDir', () => {
  it('derives <prefix>/lib/node_modules from a global entry script (POSIX)', () => {
    expect(
      resolveGlobalNodeModulesDir({
        entryScript: '/usr/local/lib/node_modules/codeam-cli/dist/index.js',
        platform: 'linux',
      }),
    ).toBe('/usr/local/lib/node_modules');
  });

  it('returns null for a non-global dev checkout', () => {
    expect(
      resolveGlobalNodeModulesDir({
        entryScript: '/home/dev/codeagent-mobile-clients/apps/cli/dist/index.js',
        platform: 'linux',
      }),
    ).toBeNull();
  });

  it('returns null on win32 (no /lib/ segment in the global layout)', () => {
    expect(
      resolveGlobalNodeModulesDir({
        entryScript: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\codeam-cli\\dist\\index.js',
        platform: 'win32',
      }),
    ).toBeNull();
  });
});

describe('sweepStaleCliStagingDirs', () => {
  const NOW = 2_000_000_000_000;
  const STALE = NOW - 10 * 60_000; // 10 min old → removable
  const FRESH = NOW - 5_000; // 5 s old → possibly in-flight, keep

  function makeDeps(entries: Array<{ name: string; mtimeMs: number }>) {
    const removed: string[] = [];
    const byName = new Map(entries.map((e) => [e.name, e.mtimeMs]));
    return {
      removed,
      deps: {
        readdirSync: (() => entries.map((e) => e.name)) as never,
        // ⚠️ Use path.basename, NOT split('/') — the source builds `full` with
        // path.join, which emits '\' on win32, so a '/'-only split leaves the
        // whole path as the "name" → byName miss → the stale dir reads as fresh
        // → the sweep no-ops (the windows-latest CI failure, 2026-07-29).
        statSync: ((full: string) => {
          const name = path.basename(full);
          return { mtimeMs: byName.get(name) ?? NOW } as never;
        }) as never,
        rmSync: ((full: string) => {
          removed.push(path.basename(full));
        }) as never,
      },
    };
  }

  it('removes a STALE leftover staging dir but keeps a FRESH one', () => {
    const { removed, deps } = makeDeps([
      { name: '.codeam-cli-oFTy4iB6', mtimeMs: STALE },
      { name: '.codeam-cli-inflight', mtimeMs: FRESH },
    ]);

    const count = sweepStaleCliStagingDirs('/usr/local/lib/node_modules', NOW, deps);

    expect(count).toBe(1);
    expect(removed).toEqual(['.codeam-cli-oFTy4iB6']);
  });

  it('ignores non-staging entries (the real package + unrelated dirs)', () => {
    const { removed, deps } = makeDeps([
      { name: 'codeam-cli', mtimeMs: STALE },
      { name: '.bin', mtimeMs: STALE },
      { name: 'some-other-pkg', mtimeMs: STALE },
    ]);

    const count = sweepStaleCliStagingDirs('/usr/local/lib/node_modules', NOW, deps);

    expect(count).toBe(0);
    expect(removed).toEqual([]);
  });

  it('is a no-op when the node_modules dir is unresolved (null)', () => {
    expect(sweepStaleCliStagingDirs(null, NOW)).toBe(0);
  });

  it('never throws when node_modules is unreadable', () => {
    const deps = {
      readdirSync: (() => {
        throw new Error('ENOENT');
      }) as never,
    };
    expect(() => sweepStaleCliStagingDirs('/nope', NOW, deps)).not.toThrow();
    expect(sweepStaleCliStagingDirs('/nope', NOW, deps)).toBe(0);
  });
});
