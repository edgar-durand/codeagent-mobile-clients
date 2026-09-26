import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runSetupCommand = vi.fn();
vi.mock('../../src/services/preview/run-setup', () => ({
  runSetupCommand: (...a: unknown[]) => runSetupCommand(...a),
}));
const whichMock = vi.fn();
vi.mock('which', () => ({ default: (...a: unknown[]) => whichMock(...a) }));

import {
  _resetPrewarmDepsForTests,
  awaitPrewarmInstall,
  prewarmNodeDeps,
} from '../../src/services/preview/prewarm-deps';

// Owner request 2026-09-25: install deps in the background at session start so
// a first Preview doesn't wait ~1.5 min on npm (measured on a CodeAgent Box).
describe('prewarmNodeDeps', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prewarm-deps-'));
    _resetPrewarmDepsForTests();
    runSetupCommand.mockReset();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('installs with npm when package.json exists and node_modules is missing', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}');
    runSetupCommand.mockResolvedValue({ status: 'ok', code: 0 });
    await prewarmNodeDeps(dir);
    expect(runSetupCommand).toHaveBeenCalledWith(
      'npm',
      ['install', '--legacy-peer-deps'],
      dir,
      undefined,
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('lets the Preview start WAIT for an install still in flight (no half-installed tree)', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}');
    let finish!: () => void;
    runSetupCommand.mockReturnValue(new Promise((r) => { finish = () => r({ status: 'ok', code: 0 }); }));
    void prewarmNodeDeps(dir);
    let waited = false;
    const wait = awaitPrewarmInstall().then(() => { waited = true; });
    await Promise.resolve();
    expect(waited).toBe(false);
    finish();
    await wait;
    expect(waited).toBe(true);
    // A second prewarm while nothing is in flight and deps are present is a no-op.
    fs.mkdirSync(path.join(dir, 'node_modules'));
    await prewarmNodeDeps(dir);
    expect(runSetupCommand).toHaveBeenCalledTimes(1);
  });

  // QA 2026-09-26: a yarn project (PrivacyHawkApp) was skipped entirely, so its
  // 1 min 46 s `yarn install` landed on the first Preview tap.
  it('installs a yarn project with yarn when yarn is already on PATH', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}');
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    whichMock.mockResolvedValue('/usr/local/bin/yarn');
    runSetupCommand.mockResolvedValue({ status: 'ok', code: 0 });
    await prewarmNodeDeps(dir);
    expect(runSetupCommand).toHaveBeenCalledTimes(1);
    expect(runSetupCommand).toHaveBeenCalledWith('yarn', ['install'], dir, undefined, expect.any(Object));
  });

  it('installs yarn first when a yarn project runs where yarn is missing', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}');
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    whichMock.mockResolvedValueOnce(null).mockResolvedValue('/usr/local/bin/yarn');
    runSetupCommand.mockResolvedValue({ status: 'ok', code: 0 });
    await prewarmNodeDeps(dir);
    expect(runSetupCommand.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['npm', ['install', '-g', 'yarn']],
      ['yarn', ['install']],
    ]);
  });

  it('leaves a yarn project to the Preview pipeline when yarn cannot be installed', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}');
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    whichMock.mockResolvedValue(null);
    runSetupCommand.mockResolvedValue({ status: 'failed', code: 1 });
    await prewarmNodeDeps(dir);
    expect(runSetupCommand).toHaveBeenCalledTimes(1);
    expect(runSetupCommand.mock.calls[0][1]).toEqual(['install', '-g', 'yarn']);
  });

  it('does nothing for a non-Node project', async () => {
    await prewarmNodeDeps(dir);
    await awaitPrewarmInstall();
    expect(runSetupCommand).not.toHaveBeenCalled();
  });
});

import {
  DEV_SERVER_READY_TIMEOUT_MS,
  MONOREPO_READY_TIMEOUT_MS,
  devServerReadyTimeoutMs,
} from '../../src/services/preview/start-orchestrator';

// Break-it 2026-09-25: an Nx app timed out (ERR_READY_TIMEOUT) while Nx was
// still building its dependency project with a silent `tsc`.
describe('devServerReadyTimeoutMs', () => {
  it('gives monorepo orchestrators room to build dependency projects', () => {
    expect(devServerReadyTimeoutMs({ framework: 'Nx', command: 'npm', args: ['run', 'dev:empresas'] })).toBe(
      MONOREPO_READY_TIMEOUT_MS,
    );
    expect(devServerReadyTimeoutMs({ framework: 'Vite', command: 'npx', args: ['turbo', 'dev'] })).toBe(
      MONOREPO_READY_TIMEOUT_MS,
    );
  });
  it('keeps the 2-minute bound for a plain dev server', () => {
    expect(devServerReadyTimeoutMs({ framework: 'Next.js', command: 'npx', args: ['next', 'dev'] })).toBe(
      DEV_SERVER_READY_TIMEOUT_MS,
    );
  });
});
