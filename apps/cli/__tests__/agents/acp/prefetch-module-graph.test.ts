import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  collectModuleGraphFiles,
  DEFAULT_MODULE_GRAPH_LIMITS,
  prefetchModuleGraph,
  readIntoPageCache,
  type ModuleGraphFs,
} from '../../../src/agents/acp/prefetch-module-graph';
import { npmAdapterPackageDir } from '../../../src/agents/acp/adapters';

// codeagent-6je7: ACP `initialize` on a cold codespace/Box disk took 8-18 s —
// node loading the adapter's module graph one cold `require` at a time. The
// graph is read in parallel before the spawn.

function write(file: string, body = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function pkg(dir: string, name: string, deps: string[] = [], optional: string[] = []): void {
  write(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name,
      dependencies: Object.fromEntries(deps.map((d) => [d, '*'])),
      optionalDependencies: Object.fromEntries(optional.map((d) => [d, '*'])),
    }),
  );
}

describe('collectModuleGraphFiles', () => {
  let root: string;
  let adapter: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-'));
    const nm = path.join(root, 'node_modules');
    adapter = path.join(nm, '@scope', 'adapter');
    // adapter → sdk (hoisted), zod (hoisted), inner (nested in adapter/node_modules)
    pkg(adapter, '@scope/adapter', ['sdk', 'zod', 'inner', 'not-installed']);
    write(path.join(adapter, 'dist', 'index.js'));
    write(path.join(adapter, 'dist', 'index.d.ts'));
    write(path.join(adapter, 'dist', 'index.js.map'));
    write(path.join(adapter, 'README.md'));
    pkg(path.join(adapter, 'node_modules', 'inner'), 'inner');
    write(path.join(adapter, 'node_modules', 'inner', 'lib.cjs'));
    // sdk depends back on the adapter (cycle) and on zod (shared dep), and has a
    // platform binary as an OPTIONAL dependency, which must not be walked.
    pkg(path.join(nm, 'sdk'), 'sdk', ['zod', '@scope/adapter'], ['sdk-linux-x64']);
    write(path.join(nm, 'sdk', 'sdk.mjs'));
    write(path.join(nm, 'sdk', 'native.node'));
    pkg(path.join(nm, 'sdk-linux-x64'), 'sdk-linux-x64');
    write(path.join(nm, 'sdk-linux-x64', 'claude.js'));
    pkg(path.join(nm, 'zod'), 'zod');
    write(path.join(nm, 'zod', 'index.js'));
    write(path.join(nm, 'zod', '.hidden', 'x.js'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('walks the package and its transitive runtime deps once each, loadable files only', async () => {
    const files = (await collectModuleGraphFiles(adapter)).map((f) => path.relative(root, f)).sort();
    expect(files).toEqual(
      [
        'node_modules/@scope/adapter/dist/index.js',
        'node_modules/@scope/adapter/node_modules/inner/lib.cjs',
        'node_modules/@scope/adapter/node_modules/inner/package.json',
        'node_modules/@scope/adapter/package.json',
        'node_modules/sdk/native.node',
        'node_modules/sdk/package.json',
        'node_modules/sdk/sdk.mjs',
        'node_modules/zod/index.js',
        'node_modules/zod/package.json',
      ].map((p) => p.split('/').join(path.sep)),
    );
  });

  it('caps the number of files', async () => {
    const files = await collectModuleGraphFiles(adapter, { maxFiles: 3 });
    expect(files).toHaveLength(3);
  });

  it('a missing package yields nothing, not a throw', async () => {
    await expect(collectModuleGraphFiles(path.join(root, 'nope'))).resolves.toEqual([]);
  });
});

describe('readIntoPageCache', () => {
  function fakeFs(sizes: Record<string, number>, failing: string[] = []): ModuleGraphFs & { reads: string[] } {
    const reads: string[] = [];
    return {
      reads,
      readdir: async () => [],
      stat: async (f) => ({ size: sizes[f] ?? 0 }),
      readFile: async (f) => {
        if (failing.includes(f)) throw new Error('EIO');
        reads.push(f);
        return Buffer.alloc(sizes[f] ?? 0);
      },
    };
  }

  it('reads every file, skipping unreadable and oversized ones', async () => {
    const fsd = fakeFs({ a: 10, b: 20, big: 100, c: 5 }, ['b']);
    const res = await readIntoPageCache(['a', 'b', 'big', 'c'], { ...DEFAULT_MODULE_GRAPH_LIMITS, maxFileBytes: 50 }, fsd);
    expect(fsd.reads.sort()).toEqual(['a', 'c']);
    expect(res).toEqual({ files: 2, bytes: 15 });
  });

  it('stops starting reads once the byte budget is spent', async () => {
    const fsd = fakeFs({ a: 10, b: 10, c: 10, d: 10 });
    await readIntoPageCache(['a', 'b', 'c', 'd'], { ...DEFAULT_MODULE_GRAPH_LIMITS, maxBytes: 15, concurrency: 1 }, fsd);
    expect(fsd.reads).toEqual(['a', 'b']);
  });

  it('never runs more than `concurrency` reads at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const fsd: ModuleGraphFs = {
      readdir: async () => [],
      stat: async () => ({ size: 1 }),
      readFile: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return Buffer.alloc(1);
      },
    };
    const files = Array.from({ length: 40 }, (_, i) => `f${i}`);
    await readIntoPageCache(files, { ...DEFAULT_MODULE_GRAPH_LIMITS, concurrency: 4 }, fsd);
    expect(peak).toBe(4);
  });
});

describe('prefetchModuleGraph', () => {
  it('never rejects, whatever the fs does', async () => {
    const fsd: ModuleGraphFs = {
      readdir: async () => {
        throw new Error('EACCES');
      },
      stat: async () => {
        throw new Error('EIO');
      },
      readFile: async () => {
        throw new Error('EIO');
      },
    };
    await expect(prefetchModuleGraph('/nonexistent', DEFAULT_MODULE_GRAPH_LIMITS, fsd)).resolves.toEqual({
      files: 0,
      bytes: 0,
    });
  });

  it('reads the real claude adapter graph (installed in this workspace)', async () => {
    const dir = npmAdapterPackageDir('claude');
    expect(dir).not.toBeNull();
    const res = await prefetchModuleGraph(dir as string);
    expect(res.files).toBeGreaterThan(10);
    expect(res.bytes).toBeGreaterThan(0);
  });
});

describe('npmAdapterPackageDir', () => {
  it('resolves the npm adapters and returns null for native ACP agents', () => {
    expect(npmAdapterPackageDir('claude')).toMatch(/claude-agent-acp$/);
    expect(npmAdapterPackageDir('codex')).toMatch(/codex-acp$/);
    expect(npmAdapterPackageDir('gemini')).toBeNull();
  });
});
