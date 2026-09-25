import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listScriptCandidates } from '../../src/services/preview/script-candidates';

// Owner request 2026-09-25: the Preview confirm sheet offers every runnable
// script so the user can pick e.g. the Expo app of a monorepo (codeagent-u88x).
describe('listScriptCandidates', () => {
  let root: string;
  const write = (rel: string, obj: unknown) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(obj));
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-cands-'));
    // Shaped like the Nx monorepo that exposed the gap (no `workspaces` field).
    write('package.json', {
      name: '@dgi/monorepo',
      devDependencies: { nx: '19' },
      scripts: { 'dev:empresas': 'nx run @dgi/web-empresas:dev', build: 'nx run-many -t build', 'deploy:api': 'x' },
    });
    write('apps/mobile-empresas/package.json', {
      name: '@dgi/mobile-empresas',
      dependencies: { expo: '~55.0.15' },
      scripts: {
        start: 'expo start',
        android: 'expo run:android',
        'deploy:android': 'cd android && ./gradlew bundleRelease && fastlane deploy',
      },
    });
    write('apps/web-empresas/package.json', {
      name: '@dgi/web-empresas',
      devDependencies: { vite: '5' },
      scripts: { dev: 'vite', build: 'vite build', test: 'vitest' },
    });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists dev-style scripts of the root and of every app, runnable from the root', () => {
    const c = listScriptCandidates(root);
    const byKey = Object.fromEntries(c.map((x) => [`${x.appDir}#${x.script}`, x]));
    expect(Object.keys(byKey).sort()).toEqual(
      ['.#dev:empresas', 'apps/mobile-empresas#start', 'apps/web-empresas#dev'].sort(),
    );
    expect(byKey['apps/mobile-empresas#start']).toMatchObject({
      app: '@dgi/mobile-empresas',
      framework: 'Expo',
      command: 'npm',
      args: ['--prefix', 'apps/mobile-empresas', 'run', 'start'],
      port: 8081,
    });
    expect(byKey['apps/web-empresas#dev']).toMatchObject({ framework: 'Vite', port: 5173 });
    expect(byKey['.#dev:empresas']).toMatchObject({ framework: 'Nx', args: ['run', 'dev:empresas'] });
  });

  it('never offers deploy, build, test or native-build scripts', () => {
    const scripts = listScriptCandidates(root).map((x) => x.script);
    expect(scripts).not.toContain('deploy:android');
    expect(scripts).not.toContain('android');
    expect(scripts).not.toContain('build');
    expect(scripts).not.toContain('test');
  });

  it('returns nothing for a repo without package.json', () => {
    fs.rmSync(path.join(root, 'package.json'));
    fs.rmSync(path.join(root, 'apps'), { recursive: true });
    expect(listScriptCandidates(root)).toEqual([]);
  });
});

import { readPreviewConfig, writePreviewConfig } from '../../src/services/preview/config-file';

describe('writePreviewConfig', () => {
  it('never persists the per-session script candidates', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    await writePreviewConfig(dir, {
      framework: 'Expo',
      command: 'npm',
      args: ['run', 'start'],
      port: 8081,
      ready_pattern: 'x',
      candidates: [
        { app: 'a', appDir: '.', script: 'start', body: 'expo start', framework: 'Expo', command: 'npm', args: ['run', 'start'], port: 8081, ready_pattern: 'x' },
      ],
    });
    const saved = await readPreviewConfig(dir);
    expect(saved).not.toHaveProperty('candidates');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
