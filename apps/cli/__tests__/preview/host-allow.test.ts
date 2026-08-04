import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPreviewHostAllow,
  restorePreviewHostAllow,
} from '../../src/services/preview/host-allow';

const nodeRequire = createRequire(__filename);
/** Load a generated CJS shim from disk and evaluate it (proves the shim is
 *  runnable JS and the merge logic produces the right config, not just that
 *  the right substrings are present). */
async function loadCjsConfig(absPath: string): Promise<Record<string, unknown>> {
  delete nodeRequire.cache[nodeRequire.resolve(absPath)];
  const mod = nodeRequire(absPath);
  const cfg = mod && mod.default ? mod.default : mod;
  return typeof cfg === 'function' ? await cfg() : await cfg;
}

/**
 * These tests exercise the crash-safe config-swap on a REAL temp dir (the same
 * pattern as setup-deps.test.ts) — the whole point of the feature is that it
 * never corrupts the user's repo, so we assert on real files, not mocks.
 */
describe('preview host-allow', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-allow-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const exists = (rel: string) => fs.existsSync(path.join(dir, rel));

  describe('Next.js (existing config)', () => {
    const ORIG = 'export default { reactStrictMode: true };\n';

    beforeEach(() => {
      fs.writeFileSync(path.join(dir, 'next.config.mjs'), ORIG);
    });

    it('wraps the config with the tunnel allow-list and backs up the original', async () => {
      await applyPreviewHostAllow(dir);

      // Original moved aside byte-for-byte.
      expect(read('next.config.codeam-orig.mjs')).toBe(ORIG);
      // Shim in place, importing the original + adding allowedDevOrigins.
      const shim = read('next.config.mjs');
      expect(shim).toContain("import __codeamUser from './next.config.codeam-orig.mjs'");
      expect(shim).toContain('allowedDevOrigins');
      expect(shim).toContain('*.trycloudflare.com');
      expect(shim).toContain('*.preview.codeagent-mobile.com');
      expect(shim).toContain('*.codeagent-mobile.com');
      // Marker records the undo.
      const marker = JSON.parse(read('.codeam/preview-host-allow.json'));
      expect(marker).toMatchObject({
        framework: 'next',
        configFile: 'next.config.mjs',
        backupFile: 'next.config.codeam-orig.mjs',
      });
    });

    it('restores the original byte-for-byte and removes the shim + marker', async () => {
      await applyPreviewHostAllow(dir);
      await restorePreviewHostAllow(dir);

      expect(read('next.config.mjs')).toBe(ORIG);
      expect(exists('next.config.codeam-orig.mjs')).toBe(false);
      expect(exists('.codeam/preview-host-allow.json')).toBe(false);
    });

    it('self-heals a leftover apply on the next bring-up (no shim-on-shim)', async () => {
      await applyPreviewHostAllow(dir);
      // Simulate a hard crash: the shim + backup + marker are on disk, but
      // restore never ran. A second apply must restore first, then re-wrap the
      // REAL original — never wrap the shim.
      await applyPreviewHostAllow(dir);

      expect(read('next.config.codeam-orig.mjs')).toBe(ORIG);
      const shim = read('next.config.mjs');
      expect(shim).toContain("import __codeamUser from './next.config.codeam-orig.mjs'");
      // Exactly one import — the original, not a shim wrapping a shim.
      expect(shim.match(/codeam-orig/g)?.length).toBe(1);

      await restorePreviewHostAllow(dir);
      expect(read('next.config.mjs')).toBe(ORIG);
    });
  });

  describe('Vite (existing config, CJS)', () => {
    const ORIG = "const { defineConfig } = require('vite');\nmodule.exports = defineConfig({});\n";

    beforeEach(() => {
      fs.writeFileSync(path.join(dir, 'vite.config.js'), ORIG);
      // No "type": "module" → CJS shim.
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
    });

    it('wraps with server.allowedHosts (leading-dot wildcards) via a CJS shim', async () => {
      await applyPreviewHostAllow(dir);

      expect(read('vite.config.codeam-orig.js')).toBe(ORIG);
      const shim = read('vite.config.js');
      expect(shim).toContain("require('./vite.config.codeam-orig.js')");
      expect(shim).toContain('allowedHosts');
      expect(shim).toContain('.trycloudflare.com');
      expect(shim).toContain('module.exports');
      const marker = JSON.parse(read('.codeam/preview-host-allow.json'));
      expect(marker).toMatchObject({ framework: 'vite', configFile: 'vite.config.js' });
    });

    it('restores the original', async () => {
      await applyPreviewHostAllow(dir);
      await restorePreviewHostAllow(dir);
      expect(read('vite.config.js')).toBe(ORIG);
      expect(exists('vite.config.codeam-orig.js')).toBe(false);
    });
  });

  describe('no framework config present', () => {
    it('creates a fresh Next config when package.json depends on next, and removes it on restore', async () => {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ dependencies: { next: '15.0.0' } }),
      );

      await applyPreviewHostAllow(dir);
      expect(exists('next.config.mjs')).toBe(true);
      expect(read('next.config.mjs')).toContain('allowedDevOrigins');
      const marker = JSON.parse(read('.codeam/preview-host-allow.json'));
      expect(marker).toMatchObject({ framework: 'next', backupFile: null });

      await restorePreviewHostAllow(dir);
      expect(exists('next.config.mjs')).toBe(false);
      expect(exists('.codeam/preview-host-allow.json')).toBe(false);
    });

    it('creates a fresh Vite config when package.json depends on vite', async () => {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ devDependencies: { vite: '5.0.0' } }),
      );

      await applyPreviewHostAllow(dir);
      expect(exists('vite.config.mjs')).toBe(true);
      expect(read('vite.config.mjs')).toContain('allowedHosts');

      await restorePreviewHostAllow(dir);
      expect(exists('vite.config.mjs')).toBe(false);
    });
  });

  describe('unsupported / no-op', () => {
    it('does nothing for a non-framework project (no config, no dep)', async () => {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
      await applyPreviewHostAllow(dir);
      expect(exists('.codeam/preview-host-allow.json')).toBe(false);
      // Nothing created.
      expect(fs.readdirSync(dir).sort()).toEqual(['package.json']);
    });

    it('restore is a silent no-op when there is no marker', async () => {
      await expect(restorePreviewHostAllow(dir)).resolves.toBeUndefined();
    });
  });

  describe('ESM detection via package.json type', () => {
    it('emits an ESM shim for a .js config when package.json is type:module', async () => {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ type: 'module', dependencies: { next: '15.0.0' } }),
      );
      fs.writeFileSync(path.join(dir, 'next.config.js'), 'export default {};\n');

      await applyPreviewHostAllow(dir);
      const shim = read('next.config.js');
      expect(shim).toContain('import __codeamUser');
      expect(shim).toContain('export default');
      expect(shim).not.toContain('module.exports');
    });
  });

  describe('generated shim is runnable + merges correctly (CJS runtime eval)', () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
    });

    it('Next: merges allowedDevOrigins, preserving + de-duping existing entries', async () => {
      fs.writeFileSync(
        path.join(dir, 'next.config.js'),
        "module.exports = { reactStrictMode: true, allowedDevOrigins: ['*.trycloudflare.com', 'existing.dev'] };\n",
      );
      await applyPreviewHostAllow(dir);
      const cfg = await loadCjsConfig(path.join(dir, 'next.config.js'));

      expect(cfg.reactStrictMode).toBe(true);
      const origins = cfg.allowedDevOrigins as string[];
      // Existing entry preserved, tunnel wildcards added, no duplicate.
      expect(origins).toContain('existing.dev');
      expect(origins).toContain('*.codeagent-mobile.com');
      expect(origins.filter((o) => o === '*.trycloudflare.com')).toHaveLength(1);
    });

    it('Next: a function config stays a function and merges the returned object', async () => {
      fs.writeFileSync(
        path.join(dir, 'next.config.js'),
        'module.exports = () => ({ basePath: "/x" });\n',
      );
      await applyPreviewHostAllow(dir);
      const cfg = await loadCjsConfig(path.join(dir, 'next.config.js'));

      expect(cfg.basePath).toBe('/x');
      expect(cfg.allowedDevOrigins).toContain('*.trycloudflare.com');
    });

    it('Vite: merges under server.allowedHosts, preserving other server keys', async () => {
      fs.writeFileSync(
        path.join(dir, 'vite.config.js'),
        'module.exports = { server: { port: 5173, allowedHosts: [".existing.dev"] } };\n',
      );
      await applyPreviewHostAllow(dir);
      const cfg = await loadCjsConfig(path.join(dir, 'vite.config.js'));

      const server = cfg.server as { port: number; allowedHosts: string[] };
      expect(server.port).toBe(5173);
      expect(server.allowedHosts).toContain('.existing.dev');
      expect(server.allowedHosts).toContain('.trycloudflare.com');
    });

    it('Vite: server.allowedHosts === true (allow-all) is left as true, not clobbered', async () => {
      fs.writeFileSync(
        path.join(dir, 'vite.config.js'),
        'module.exports = { server: { allowedHosts: true } };\n',
      );
      await applyPreviewHostAllow(dir);
      const cfg = await loadCjsConfig(path.join(dir, 'vite.config.js'));

      const server = cfg.server as { allowedHosts: boolean };
      expect(server.allowedHosts).toBe(true);
    });
  });

  describe('config precedence', () => {
    it('prefers Next over Vite when both configs exist', async () => {
      fs.writeFileSync(path.join(dir, 'next.config.mjs'), 'export default {};\n');
      fs.writeFileSync(path.join(dir, 'vite.config.mjs'), 'export default {};\n');

      await applyPreviewHostAllow(dir);
      const marker = JSON.parse(read('.codeam/preview-host-allow.json'));
      expect(marker.framework).toBe('next');
      // Vite config untouched.
      expect(read('vite.config.mjs')).toBe('export default {};\n');
    });
  });
});
