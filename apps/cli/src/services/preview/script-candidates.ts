import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PreviewScriptCandidate } from '@codeam/shared';

/**
 * Runnable dev-style scripts across the repo — the root package.json and
 * every workspace app — shaped as ready-to-start detections, for the Preview
 * confirm sheet's autocomplete (owner request 2026-09-25). In a monorepo the
 * agent picks ONE app; the Expo app of an Nx repo was unreachable from the
 * app (bead codeagent-u88x).
 *
 * Sub-app scripts run from the repo root as `npm --prefix <dir> run <script>`,
 * so the existing Preview pipeline (root install, spawn cwd, Expo `--port`
 * pass-through) needs no new field.
 *
 * Deploy/publish/build/test-style scripts are left out on purpose: a Preview
 * tap must never run `deploy:android` (fastlane) or a release.
 */

type Pkg = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
};

const EXCLUDE_RE =
  /(^|:)(deploy|publish|release|build|test|e2e|lint|format|typecheck|type-check|clean|prebuild|postinstall|preinstall|prepare|install|migrate|seed|db|prisma|codegen|storybook-build)(:|$)/i;
// Native builds can't produce a preview and need an SDK the box doesn't have.
const EXCLUDE_BODY_RE = /\b(run:android|run:ios|gradlew|fastlane|xcodebuild|eas build|eas submit)\b/i;
const MAX_APPS = 40;
const MAX_CANDIDATES = 120;

type FrameworkDefaults = { framework: string; port: number; ready_pattern: string };

function frameworkFor(pkg: Pkg, body: string): FrameworkDefaults {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = (d: string) => d in deps || new RegExp(`\\b${d}\\b`).test(body);
  if (has('expo')) return { framework: 'Expo', port: 8081, ready_pattern: 'Waiting on http|Metro waiting|Logs for your project' };
  if (has('next')) return { framework: 'Next.js', port: 3000, ready_pattern: 'Ready in|Local:.*http' };
  if (has('vite')) return { framework: 'Vite', port: 5173, ready_pattern: 'Local:.*http' };
  if (has('@angular/cli') || /\bng serve\b/.test(body)) return { framework: 'Angular', port: 4200, ready_pattern: 'Local:.*http|compiled successfully' };
  if (has('react-scripts')) return { framework: 'Create React App', port: 3000, ready_pattern: 'Compiled|Local:.*http' };
  if (has('nx') || /\bnx\b/.test(body)) return { framework: 'Nx', port: 4200, ready_pattern: 'Local:.*http|ready|listening' };
  return { framework: 'Node', port: 3000, ready_pattern: 'Local:.*http|ready|listening|started' };
}

function readPkg(file: string): Pkg | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Pkg;
  } catch {
    return null;
  }
}

/** One-level globs only (`apps/*`, `packages/*`) — what monorepos actually use. */
function expandGlob(root: string, pattern: string): string[] {
  const clean = pattern.replace(/\/+$/, '');
  if (!clean.endsWith('/*')) return [clean];
  const base = clean.slice(0, -2);
  try {
    return fs
      .readdirSync(path.join(root, base), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => path.join(base, d.name));
  } catch {
    return [];
  }
}

function workspaceDirs(root: string, rootPkg: Pkg | null): string[] {
  const ws = rootPkg?.workspaces;
  const patterns = Array.isArray(ws) ? ws : (ws?.packages ?? []);
  try {
    const pnpm = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    for (const m of pnpm.matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?\s*$/gm)) patterns.push(m[1]);
  } catch {
    /* no pnpm workspace */
  }
  // Nx / hand-rolled monorepos often declare nothing: fall back to the usual dirs.
  if (patterns.length === 0) patterns.push('apps/*', 'packages/*');
  const dirs = new Set<string>();
  for (const p of patterns) for (const d of expandGlob(root, p)) dirs.add(d);
  return [...dirs].slice(0, MAX_APPS);
}

export function listScriptCandidates(root: string): PreviewScriptCandidate[] {
  const out: PreviewScriptCandidate[] = [];
  const rootPkg = readPkg(path.join(root, 'package.json'));
  const add = (pkg: Pkg, appDir: string): void => {
    for (const [script, body] of Object.entries(pkg.scripts ?? {})) {
      if (out.length >= MAX_CANDIDATES) return;
      if (EXCLUDE_RE.test(script) || EXCLUDE_BODY_RE.test(body)) continue;
      const fw = frameworkFor(pkg, body);
      out.push({
        app: pkg.name ?? (appDir === '.' ? path.basename(root) : appDir),
        appDir,
        script,
        body,
        framework: fw.framework,
        command: 'npm',
        args: appDir === '.' ? ['run', script] : ['--prefix', appDir, 'run', script],
        port: fw.port,
        ready_pattern: fw.ready_pattern,
      });
    }
  };
  if (rootPkg) add(rootPkg, '.');
  for (const dir of workspaceDirs(root, rootPkg)) {
    const pkg = readPkg(path.join(root, dir, 'package.json'));
    if (pkg) add(pkg, dir.split(path.sep).join('/'));
  }
  return out;
}
