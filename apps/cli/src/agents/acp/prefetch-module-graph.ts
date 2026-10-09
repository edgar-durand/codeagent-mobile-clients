import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Warm the page cache with an ACP adapter's whole module graph (its own files
 * plus every runtime dependency's) before the adapter is spawned.
 *
 * ⚠️ Why (codeagent-6je7, follow-up of codeagent-w683): after the claude binary
 * prefetch, the remaining cold-start cost on a codespace / Box is ACP
 * `initialize` — node loading `claude-agent-acp` and its dependencies, many
 * small files read one `require` at a time. Sampled on a cold QA codespace the
 * adapter processes sat in D state (`__wait_on_buffer`, `d_alloc_parallel`)
 * under `node_modules/@agentclientprotocol/...` and `initialize` took 8-18 s,
 * against 4-6 s warm. Reading the graph in parallel, while the CLI is still
 * doing its own start-up, turns those serial misses into one concurrent burst.
 *
 * Best-effort and bounded: missing packages, unreadable files and every other
 * error are skipped; the adapter then just pages things in itself, as before.
 */

/** Only what node actually loads. `.d.ts` and source maps are skipped below. */
const LOADABLE_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.node']);

export interface ModuleGraphLimits {
  /** Stop collecting after this many files. */
  maxFiles: number;
  /** Stop reading once this many bytes have been read. */
  maxBytes: number;
  /** Files larger than this are not read (the 200 MB native agent binary has
   *  its own sequential prefetch, `prefetchIntoPageCache`). */
  maxFileBytes: number;
  /** Parallel reads. */
  concurrency: number;
}

export const DEFAULT_MODULE_GRAPH_LIMITS: ModuleGraphLimits = {
  maxFiles: 2_000,
  maxBytes: 48 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  concurrency: 16,
};

/** The fs surface the walker uses — injectable so tests can count reads. */
export interface ModuleGraphFs {
  readdir(dir: string): Promise<fs.Dirent[]>;
  readFile(file: string): Promise<Buffer>;
  stat(file: string): Promise<{ size: number }>;
}

const realFs: ModuleGraphFs = {
  readdir: (dir) => fs.promises.readdir(dir, { withFileTypes: true }),
  readFile: (file) => fs.promises.readFile(file),
  stat: (file) => fs.promises.stat(file),
};

/**
 * Node's lookup for a bare dependency from inside a package: the nearest
 * `node_modules/<dep>` walking up from that package's directory.
 */
function findPackageDir(dep: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', dep);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function runtimeDependencies(pkgDir: string): string[] {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    // `optionalDependencies` are left out on purpose: for the agent SDK they
    // are the per-platform native binaries, which have their own prefetch.
    return Object.keys(manifest.dependencies ?? {});
  } catch {
    return [];
  }
}

/** Loadable files of ONE package, not descending into its own node_modules
 *  (those are reached as dependencies, so each package is walked once). */
async function packageFiles(
  pkgDir: string,
  fsd: ModuleGraphFs,
  out: string[],
  maxFiles: number,
): Promise<void> {
  const stack = [pkgDir];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fsd.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.map')) continue;
      if (LOADABLE_EXT.has(path.extname(entry.name))) out.push(full);
    }
  }
}

/**
 * Every loadable file of `rootPkgDir` and its transitive runtime dependencies,
 * each package once (cycles and shared deps are deduplicated), capped at
 * `limits.maxFiles`.
 */
export async function collectModuleGraphFiles(
  rootPkgDir: string,
  limits: Pick<ModuleGraphLimits, 'maxFiles'> = DEFAULT_MODULE_GRAPH_LIMITS,
  fsd: ModuleGraphFs = realFs,
): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  const queue = [rootPkgDir];
  while (queue.length > 0 && files.length < limits.maxFiles) {
    const pkgDir = queue.shift() as string;
    const key = fs.existsSync(pkgDir) ? fs.realpathSync(pkgDir) : pkgDir;
    if (seen.has(key)) continue;
    seen.add(key);
    await packageFiles(pkgDir, fsd, files, limits.maxFiles);
    for (const dep of runtimeDependencies(pkgDir)) {
      const depDir = findPackageDir(dep, pkgDir);
      if (depDir) queue.push(depDir);
    }
  }
  return files;
}

/**
 * Read `files` with bounded concurrency, discarding the bytes. Stops starting
 * new reads once `maxBytes` have been read. Resolves with what was read; never
 * rejects.
 */
export async function readIntoPageCache(
  files: readonly string[],
  limits: Omit<ModuleGraphLimits, 'maxFiles'> = DEFAULT_MODULE_GRAPH_LIMITS,
  fsd: ModuleGraphFs = realFs,
): Promise<{ files: number; bytes: number }> {
  let next = 0;
  let bytes = 0;
  let read = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length && bytes < limits.maxBytes) {
      const file = files[next++];
      try {
        if ((await fsd.stat(file)).size > limits.maxFileBytes) continue;
        // Await FIRST: `bytes += await …` would read `bytes` before the await
        // and drop the other workers' additions.
        const buf = await fsd.readFile(file);
        bytes += buf.length;
        read += 1;
      } catch {
        /* vanished / unreadable — skip */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limits.concurrency) }, worker));
  return { files: read, bytes };
}

/**
 * Fire-and-forget: collect and read the module graph of the package at
 * `pkgDir`. Returns the promise only so tests can await it; callers ignore it.
 */
export function prefetchModuleGraph(
  pkgDir: string,
  limits: ModuleGraphLimits = DEFAULT_MODULE_GRAPH_LIMITS,
  fsd: ModuleGraphFs = realFs,
): Promise<{ files: number; bytes: number }> {
  return collectModuleGraphFiles(pkgDir, limits, fsd)
    .then((files) => readIntoPageCache(files, limits, fsd))
    .catch(() => ({ files: 0, bytes: 0 }));
}
