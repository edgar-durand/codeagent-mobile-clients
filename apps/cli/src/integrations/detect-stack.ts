// src/integrations/detect-stack.ts
//
// Session Tools "Recommended" — detect the repo's stack from its dependency
// manifests and recommend relevant Agent Toolkit integrations. The mapping is
// PURE and lives in @codeam/shared (recommendForDeps); this module is the
// filesystem half: read the repo at cwd, collect raw dependency NAMES, then
// consult the shared map. When the deterministic scan finds NOTHING (an
// unrecognized stack), fall back to a bounded agent one-shot (B) constrained to
// our catalog. Best-effort throughout — never throws; a miss just yields fewer
// suggestions.
import fs from 'node:fs';
import path from 'node:path';
import {
  recommendForDeps,
  getEnabledIntegrations,
  isKnownIntegrationId,
  type IntegrationId,
  type RepoStackDetection,
} from '@codeam/shared';
import type { RuntimeStrategy } from '../agents/strategy';
import { log } from '../services/logger';

/** Read a file at cwd, returning '' on any error (missing/permission). */
function readSafe(cwd: string, rel: string): string {
  try {
    return fs.readFileSync(path.join(cwd, rel), 'utf8');
  } catch {
    return '';
  }
}

/** Collect dependency NAMES across the ecosystems we recognize (best-effort). */
export function collectRepoDeps(cwd: string): string[] {
  const names = new Set<string>();

  // package.json — dependencies + devDependencies keys.
  const pkgRaw = readSafe(cwd, 'package.json');
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const k of Object.keys(pkg.dependencies ?? {})) names.add(k);
      for (const k of Object.keys(pkg.devDependencies ?? {})) names.add(k);
    } catch {
      // malformed package.json — skip
    }
  }

  // requirements.txt — one package per line (strip version specifiers/comments).
  const req = readSafe(cwd, 'requirements.txt');
  for (const line of req.split('\n')) {
    const name = line.trim().split(/[=<>!~;[\s]/)[0];
    if (name && !name.startsWith('#') && !name.startsWith('-')) names.add(name.toLowerCase());
  }

  // pyproject.toml — dependency lines (naive: names in [tool.poetry.dependencies]
  // or a PEP 621 dependencies array).
  const pyproject = readSafe(cwd, 'pyproject.toml');
  for (const m of pyproject.matchAll(/^\s*["']?([A-Za-z0-9._-]+)["']?\s*[=~<>]/gm)) {
    if (m[1]) names.add(m[1].toLowerCase());
  }

  // go.mod — `require` module paths (last path segment is the closest to a name).
  const goMod = readSafe(cwd, 'go.mod');
  for (const m of goMod.matchAll(/^\s*([\w./-]+)\s+v\d/gm)) {
    if (m[1]) names.add(m[1]);
  }

  // Gemfile — gem 'name'.
  const gemfile = readSafe(cwd, 'Gemfile');
  for (const m of gemfile.matchAll(/^\s*gem\s+["']([A-Za-z0-9._-]+)["']/gm)) {
    if (m[1]) names.add(m[1]);
  }

  // composer.json — require + require-dev keys (vendor/package).
  const composerRaw = readSafe(cwd, 'composer.json');
  if (composerRaw) {
    try {
      const composer = JSON.parse(composerRaw) as {
        require?: Record<string, string>;
        'require-dev'?: Record<string, string>;
      };
      for (const k of Object.keys(composer.require ?? {})) names.add(k);
      for (const k of Object.keys(composer['require-dev'] ?? {})) names.add(k);
    } catch {
      // skip
    }
  }

  // Cargo.toml — crate names under [dependencies]/[dev-dependencies].
  const cargo = readSafe(cwd, 'Cargo.toml');
  const cargoDepsBlock = cargo.match(/\[(?:dev-)?dependencies\]([\s\S]*?)(?:\n\[|$)/g);
  if (cargoDepsBlock) {
    for (const block of cargoDepsBlock) {
      for (const m of block.matchAll(/^\s*([A-Za-z0-9._-]+)\s*=/gm)) {
        if (m[1] && m[1] !== 'dependencies' && m[1] !== 'dev-dependencies') names.add(m[1]);
      }
    }
  }

  return [...names];
}

/** Enabled catalog ids the agent fallback is allowed to suggest. */
function enabledCatalogIds(): IntegrationId[] {
  return getEnabledIntegrations().map((m) => m.id);
}

/** Parse the agent one-shot reply into a validated, catalog-constrained id list. */
function parseAgentSuggestions(raw: string): IntegrationId[] {
  const match = raw.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const enabled = new Set<string>(enabledCatalogIds());
  const out: IntegrationId[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    if (typeof v === 'string' && isKnownIntegrationId(v) && enabled.has(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Detect the repo stack and recommend integrations. Deterministic scan first (A);
 * when it yields nothing, a bounded agent one-shot (B) constrained to the enabled
 * catalog. Always resolves — a total miss returns an empty `unknown` result.
 */
export async function detectRepoStack(
  cwd: string,
  runtime?: Pick<RuntimeStrategy, 'generateOneShot'>,
): Promise<RepoStackDetection> {
  const deps = collectRepoDeps(cwd);
  const scan = recommendForDeps(deps);
  if (scan.detected.length > 0 || scan.recommended.length > 0) return scan;

  // A found nothing → B (agent one-shot), best-effort.
  if (!runtime?.generateOneShot) return scan;
  try {
    const catalog = enabledCatalogIds().join(', ');
    const prompt =
      'Inspect this repository (frameworks, languages, services it integrates with) and ' +
      'suggest which of these developer tools would be most useful to connect. ' +
      `Respond with ONLY a JSON array of ids chosen from this exact set: [${catalog}]. ` +
      'No prose, no ids outside the set. Example: ["sentry","posthog"].';
    const reply = await runtime.generateOneShot(prompt, { cwd, timeoutMs: 45_000 });
    if (!reply) return scan;
    const recommended = parseAgentSuggestions(reply);
    return { stack: scan.stack, detected: [], recommended, source: 'agent' };
  } catch (err) {
    log.warn('integrations', `stack detect agent fallback failed: ${err instanceof Error ? err.message : String(err)}`);
    return scan;
  }
}
