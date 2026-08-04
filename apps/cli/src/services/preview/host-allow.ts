/**
 * Preview dev-server host allow-listing.
 *
 * WHY: modern framework dev servers reject requests whose Host/Origin is the
 * public tunnel domain (a security default against cross-origin dev requests):
 *   - Next.js 15+  → `allowedDevOrigins` (server actions / API routes from a
 *     disallowed origin are BLOCKED — Rafael's login stopped working until he
 *     hand-added our tunnel domains, 2026-08-04).
 *   - Vite         → `server.allowedHosts` ("Blocked request. This host is not
 *     allowed.").
 * We spawn the dev server BEHIND our Cloudflare tunnel, so without this the
 * user must hand-edit their config every time — and the quick-tunnel subdomain
 * is RANDOM per restart, so a hardcoded host goes stale immediately.
 *
 * WHAT: before spawning the dev server we detect the framework (by config-file
 * presence, since `detection.framework` is free-form agent text) and make its
 * dev server trust our tunnel via WILDCARDS (`*.trycloudflare.com`,
 * `*.preview.codeagent-mobile.com`, `*.codeagent-mobile.com`) — a wildcard, not
 * the exact host, because the dev server spawns BEFORE the tunnel URL is known
 * and the subdomain changes on every restart.
 *
 * HOW (non-destructive, crash-safe): we NEVER edit the user's config in place.
 * We move it aside byte-for-byte (`<name>` → `<name>.codeam-orig<ext>`) and drop
 * a tiny SHIM in its place that imports the original and merges the allow-list
 * (handling object / function / async-function / Promise config shapes). On
 * preview stop we restore the original and delete the shim. A marker file
 * (`.codeam/preview-host-allow.json`) records exactly what to undo, so a hard
 * crash self-heals on the next bring-up (we restore any leftover BEFORE applying
 * fresh). If no framework config exists we create a minimal one and delete it on
 * restore. Anything unexpected degrades to a no-op — a preview host-allow must
 * never corrupt or block the user's repo.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { log } from '../logger';

/** Next `allowedDevOrigins` accepts wildcard subdomain patterns (Next 15.2+,
 *  which is what Rafael's working config used). */
const NEXT_ALLOWED_ORIGINS = [
  '*.trycloudflare.com',
  '*.preview.codeagent-mobile.com',
  '*.codeagent-mobile.com',
];

/** Vite `server.allowedHosts` uses a leading dot for "this domain + all
 *  subdomains". */
const VITE_ALLOWED_HOSTS = [
  '.trycloudflare.com',
  '.preview.codeagent-mobile.com',
  '.codeagent-mobile.com',
];

type Framework = 'next' | 'vite';

const CONFIG_BASENAMES: Record<Framework, string> = {
  next: 'next.config',
  vite: 'vite.config',
};

/** Config extensions we understand, in preference order. */
const CONFIG_EXTS = ['.ts', '.mjs', '.js', '.cjs', '.mts'] as const;

const MARKER_DIR = '.codeam';
const MARKER_FILE = 'preview-host-allow.json';
/** Infix inserted before the extension when moving the user's config aside. */
const ORIG_INFIX = '.codeam-orig';

interface HostAllowMarker {
  framework: Framework;
  /** Basename of the config the shim occupies (e.g. `next.config.mjs`). */
  configFile: string;
  /** Basename of the moved-aside original, or null when we created a fresh
   *  config (nothing to restore — just delete the shim). */
  backupFile: string | null;
}

function markerPath(cwd: string): string {
  return path.join(cwd, MARKER_DIR, MARKER_FILE);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** First existing `<basename><ext>` for a framework, or null. */
async function findConfigFile(cwd: string, framework: Framework): Promise<string | null> {
  const base = CONFIG_BASENAMES[framework];
  for (const ext of CONFIG_EXTS) {
    if (await fileExists(path.join(cwd, `${base}${ext}`))) return `${base}${ext}`;
  }
  return null;
}

/** Does package.json declare this framework as a dependency? Used to decide
 *  whether to CREATE a fresh config when the project has none. */
async function dependsOn(cwd: string, pkgName: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return !!(pkg.dependencies?.[pkgName] ?? pkg.devDependencies?.[pkgName]);
  } catch {
    return false;
  }
}

/** ESM vs CJS for a config file — decides the shim's module syntax. */
async function isEsmConfig(cwd: string, configFile: string): Promise<boolean> {
  const ext = path.extname(configFile);
  if (ext === '.mjs' || ext === '.mts' || ext === '.ts') return true;
  if (ext === '.cjs') return false;
  // `.js` → follow package.json "type".
  try {
    const raw = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
    return (JSON.parse(raw) as { type?: string }).type === 'module';
  } catch {
    return false;
  }
}

function nextShim(origBasename: string | null, esm: boolean): string {
  const list = JSON.stringify(NEXT_ALLOWED_ORIGINS);
  const merge = `
function __codeamWithAllow(cfg) {
  var c = cfg && typeof cfg === 'object' ? Object.assign({}, cfg) : {};
  var existing = Array.isArray(c.allowedDevOrigins) ? c.allowedDevOrigins : [];
  c.allowedDevOrigins = Array.from(new Set(existing.concat(${list})));
  return c;
}
function __codeamMerge(base) {
  if (typeof base === 'function') {
    return function () {
      var r = base.apply(null, arguments);
      return r && typeof r.then === 'function' ? r.then(__codeamWithAllow) : __codeamWithAllow(r);
    };
  }
  return base && typeof base.then === 'function' ? base.then(__codeamWithAllow) : __codeamWithAllow(base);
}`;
  if (origBasename) {
    return esm
      ? `// codeam preview host-allow shim — auto-generated, restored on preview stop.\nimport __codeamUser from './${origBasename}';\n${merge}\nexport default __codeamMerge(__codeamUser);\n`
      : `// codeam preview host-allow shim — auto-generated, restored on preview stop.\nvar __codeamUser = require('./${origBasename}');\n${merge}\nmodule.exports = __codeamMerge(__codeamUser && __codeamUser.default ? __codeamUser.default : __codeamUser);\n`;
  }
  // No original — a fresh minimal config.
  return esm
    ? `// codeam preview host-allow shim — auto-generated, removed on preview stop.\nexport default { allowedDevOrigins: ${list} };\n`
    : `// codeam preview host-allow shim — auto-generated, removed on preview stop.\nmodule.exports = { allowedDevOrigins: ${list} };\n`;
}

function viteShim(origBasename: string | null, esm: boolean): string {
  const list = JSON.stringify(VITE_ALLOWED_HOSTS);
  const merge = `
function __codeamWithAllow(cfg) {
  var c = cfg && typeof cfg === 'object' ? Object.assign({}, cfg) : {};
  var server = Object.assign({}, c.server || {});
  if (server.allowedHosts === true) { c.server = server; return c; }
  var existing = Array.isArray(server.allowedHosts) ? server.allowedHosts : [];
  server.allowedHosts = Array.from(new Set(existing.concat(${list})));
  c.server = server;
  return c;
}
function __codeamMerge(base) {
  if (typeof base === 'function') {
    return function () {
      var r = base.apply(null, arguments);
      return r && typeof r.then === 'function' ? r.then(__codeamWithAllow) : __codeamWithAllow(r);
    };
  }
  return base && typeof base.then === 'function' ? base.then(__codeamWithAllow) : __codeamWithAllow(base);
}`;
  if (origBasename) {
    return esm
      ? `// codeam preview host-allow shim — auto-generated, restored on preview stop.\nimport __codeamUser from './${origBasename}';\n${merge}\nexport default __codeamMerge(__codeamUser);\n`
      : `// codeam preview host-allow shim — auto-generated, restored on preview stop.\nvar __codeamUser = require('./${origBasename}');\n${merge}\nmodule.exports = __codeamMerge(__codeamUser && __codeamUser.default ? __codeamUser.default : __codeamUser);\n`;
  }
  return esm
    ? `// codeam preview host-allow shim — auto-generated, removed on preview stop.\nexport default { server: { allowedHosts: ${list} } };\n`
    : `// codeam preview host-allow shim — auto-generated, removed on preview stop.\nmodule.exports = { server: { allowedHosts: ${list} } };\n`;
}

function shimFor(framework: Framework, origBasename: string | null, esm: boolean): string {
  return framework === 'next' ? nextShim(origBasename, esm) : viteShim(origBasename, esm);
}

async function writeMarker(cwd: string, marker: HostAllowMarker): Promise<void> {
  await fs.mkdir(path.join(cwd, MARKER_DIR), { recursive: true });
  await fs.writeFile(markerPath(cwd), JSON.stringify(marker, null, 2), 'utf8');
}

async function readMarker(cwd: string): Promise<HostAllowMarker | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath(cwd), 'utf8')) as HostAllowMarker;
    return parsed && parsed.configFile ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Undo a prior apply from the marker: delete the shim and move the original
 * back (or just delete a fresh-created config). Idempotent — a missing marker
 * or missing files is a silent no-op. Safe to call on every stop AND at the
 * start of every apply (crash self-heal).
 */
export async function restorePreviewHostAllow(cwd: string): Promise<void> {
  const marker = await readMarker(cwd);
  if (!marker) return;
  try {
    const configAbs = path.join(cwd, marker.configFile);
    if (marker.backupFile) {
      // Restore the user's original: remove our shim, move the backup back.
      const backupAbs = path.join(cwd, marker.backupFile);
      if (await fileExists(backupAbs)) {
        await fs.rm(configAbs, { force: true });
        await fs.rename(backupAbs, configAbs);
      }
    } else {
      // We created a fresh config — delete it.
      await fs.rm(configAbs, { force: true });
    }
  } catch (err) {
    log.warn('preview', `host-allow restore failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    await fs.rm(markerPath(cwd), { force: true }).catch(() => undefined);
  }
}

/**
 * Make the project's dev server (Next / Vite) trust our tunnel domains BEFORE
 * it spawns. Self-heals any leftover from a prior crash first, then applies.
 * Best-effort: any failure degrades to a no-op (never blocks the preview, never
 * leaves the repo half-edited — the original is moved, never mutated).
 */
export async function applyPreviewHostAllow(cwd: string): Promise<void> {
  try {
    // 1. Undo any leftover apply (a prior hard crash) so we start from the
    //    user's real config, never shim-on-shim.
    await restorePreviewHostAllow(cwd);

    // 2. Detect the framework by config presence, then package.json deps.
    let framework: Framework | null = null;
    let existing: string | null = null;
    for (const f of ['next', 'vite'] as Framework[]) {
      const cfg = await findConfigFile(cwd, f);
      if (cfg) {
        framework = f;
        existing = cfg;
        break;
      }
    }
    if (!framework) {
      if (await dependsOn(cwd, 'next')) framework = 'next';
      else if (await dependsOn(cwd, 'vite')) framework = 'vite';
    }
    if (!framework) return; // not a framework we host-allow — no-op.

    if (existing) {
      const ext = path.extname(existing);
      const origBasename = `${CONFIG_BASENAMES[framework]}${ORIG_INFIX}${ext}`;
      const esm = await isEsmConfig(cwd, existing);
      // Move the user's config aside byte-for-byte, then drop the shim in its
      // place. The original is never mutated — restore renames it straight back.
      await fs.rename(path.join(cwd, existing), path.join(cwd, origBasename));
      await fs.writeFile(path.join(cwd, existing), shimFor(framework, origBasename, esm), 'utf8');
      await writeMarker(cwd, { framework, configFile: existing, backupFile: origBasename });
      log.info('preview', `host-allow: wrapped ${existing} (${framework}) for tunnel access`);
    } else {
      // No config — create a fresh minimal one (ESM by default; harmless on
      // older framework versions, which ignore unknown keys).
      const configFile = `${CONFIG_BASENAMES[framework]}.mjs`;
      await fs.writeFile(path.join(cwd, configFile), shimFor(framework, null, true), 'utf8');
      await writeMarker(cwd, { framework, configFile, backupFile: null });
      log.info('preview', `host-allow: created ${configFile} (${framework}) for tunnel access`);
    }
  } catch (err) {
    log.warn('preview', `host-allow apply skipped: ${err instanceof Error ? err.message : err}`);
  }
}
