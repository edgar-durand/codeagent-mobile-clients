import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import {
  detectMissingNodeDeps,
  ensureYarnInstalled,
  ensureExpoTunnelDeps,
  isExpoTunnelCommand,
  ngrokResolvesFrom,
  EXPO_NGROK_SPEC,
  isJsInstallCommand,
} from '../../src/services/preview/setup-deps';

describe('detectMissingNodeDeps', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-deps-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when there is no package.json (non-Node project)', () => {
    expect(detectMissingNodeDeps(dir)).toBeNull();
  });

  it('returns null when node_modules already exists (trust it)', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    expect(detectMissingNodeDeps(dir)).toBeNull();
  });

  it('defaults to npm install --legacy-peer-deps when no lockfile is present', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(detectMissingNodeDeps(dir)).toEqual({
      cmd: 'npm',
      args: ['install', '--legacy-peer-deps'],
    });
  });

  it('uses npm --legacy-peer-deps when package-lock.json is present', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    expect(detectMissingNodeDeps(dir)).toEqual({
      cmd: 'npm',
      args: ['install', '--legacy-peer-deps'],
    });
  });

  // REGRESSION: a pnpm-lock project used to return `pnpm install`, which
  // crashes on the codespace's Node 20 (pnpm ≥10 needs Node ≥22.13) →
  // node_modules never created → `next dev` "next: not found" → stuck
  // preview / ERR_SPAWN_FAILED. Must use npm instead. (FAILS pre-fix.)
  it('uses npm --legacy-peer-deps for a pnpm-lock project (pnpm cannot run on Node 20)', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    expect(detectMissingNodeDeps(dir)).toEqual({
      cmd: 'npm',
      args: ['install', '--legacy-peer-deps'],
    });
  });

  it('keeps yarn when yarn.lock is present (yarn classic runs on Node 20)', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    expect(detectMissingNodeDeps(dir)).toEqual({ cmd: 'yarn', args: ['install'] });
  });

  it('uses npm --legacy-peer-deps for a bun project (bun often absent)', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'bun.lockb'), '');
    expect(detectMissingNodeDeps(dir)).toEqual({
      cmd: 'npm',
      args: ['install', '--legacy-peer-deps'],
    });
  });

  it('prefers yarn over a pnpm lockfile when both exist (yarn is runnable)', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    expect(detectMissingNodeDeps(dir)).toEqual({ cmd: 'yarn', args: ['install'] });
  });
});

describe('ensureYarnInstalled', () => {
  it('no-ops when yarn is already on PATH (no install)', async () => {
    const installYarn = vi.fn();
    const res = await ensureYarnInstalled({
      hasYarn: async () => true,
      installYarn,
    });
    expect(res).toEqual({ ok: true, code: 0 });
    expect(installYarn).not.toHaveBeenCalled();
  });

  it('installs yarn when missing, then confirms it resolves (the codespace fix)', async () => {
    const hasYarn = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false) // initial probe: not on PATH
      .mockResolvedValueOnce(true); // after install: now resolves
    const installYarn = vi.fn(async () => ({ ok: true, code: 0 }));
    const res = await ensureYarnInstalled({ hasYarn, installYarn });
    expect(installYarn).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, code: 0 });
  });

  it('reports failure (with exit code) when the yarn install fails', async () => {
    const res = await ensureYarnInstalled({
      hasYarn: async () => false,
      installYarn: async () => ({ ok: false, code: 1 }),
    });
    expect(res).toEqual({ ok: false, code: 1 });
  });

  it('reports failure when install "succeeds" but yarn still is not on PATH', async () => {
    const res = await ensureYarnInstalled({
      hasYarn: async () => false, // never resolves, even after install
      installYarn: async () => ({ ok: true, code: 0 }),
    });
    expect(res.ok).toBe(false);
  });
});

describe('isJsInstallCommand', () => {
  it.each([
    ['npm', ['install'], true],
    ['npm', ['i'], true],
    ['npm', ['ci'], true],
    ['pnpm', ['install'], true],
    ['pnpm', ['i'], true],
    ['yarn', ['install'], true],
    ['yarn', [], true],
    ['bun', ['install'], true],
    ['bun', ['i'], true],
  ])('detects %s %s as an install command', (cmd, args, expected) => {
    expect(isJsInstallCommand(cmd, args as string[])).toBe(expected);
  });

  it.each([
    ['npx', ['prisma', 'generate']],
    ['npm', ['run', 'build']],
    ['pnpm', ['run', 'prebuild']],
    ['yarn', ['build']],
    ['bun', ['run', 'setup']],
    ['make', []],
    ['cargo', ['build']],
    ['python', ['-m', 'pip', 'install', '-r', 'requirements.txt']],
  ])('does not detect %s %s as an install command', (cmd, args) => {
    expect(isJsInstallCommand(cmd, args as string[])).toBe(false);
  });
});

describe('Expo tunnel needs @expo/ngrok (rafaelph90, 2026-09-04: "Server Failed to Start")', () => {
  it('recognises our own Expo recipe and its normalized forms, and nothing else', () => {
    expect(isExpoTunnelCommand('npx', ['expo', 'start', '--tunnel'])).toBe(true);
    // After normalizeDetectionForSpawn: the project-local bin, args without the bin name.
    expect(isExpoTunnelCommand('/repo/node_modules/.bin/expo', ['start', '--tunnel'])).toBe(true);
    expect(isExpoTunnelCommand('npx', ['expo', 'start'])).toBe(false); // LAN mode: no ngrok
    expect(isExpoTunnelCommand('npm', ['run', 'dev'])).toBe(false);
  });

  it('installs @expo/ngrok project-locally only when it does not resolve, then re-checks', async () => {
    let present = false;
    const installNgrok = async () => {
      present = true;
      return { ok: true, code: 0 };
    };
    const r = await ensureExpoTunnelDeps({ hasNgrok: async () => present, installNgrok });
    expect(r).toEqual({ ok: true, code: 0, installed: true });

    // Already there → no install at all (the baked box image case).
    let calls = 0;
    const r2 = await ensureExpoTunnelDeps({
      hasNgrok: async () => true,
      installNgrok: async () => {
        calls++;
        return { ok: true, code: 0 };
      },
    });
    expect(r2).toEqual({ ok: true, code: 0, installed: false });
    expect(calls).toBe(0);
  });

  it('reports a failed install honestly instead of letting Expo hit its interactive prompt', async () => {
    const r = await ensureExpoTunnelDeps({
      hasNgrok: async () => false,
      installNgrok: async () => ({ ok: false, code: 243 }),
    });
    expect(r).toEqual({ ok: false, code: 243, installed: false });
  });

  it('resolves ngrok from a project tree, not from the CLI itself', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-ngrok-'));
    expect(ngrokResolvesFrom(dir)).toBe(false);
    fs.mkdirSync(path.join(dir, 'node_modules', '@expo', 'ngrok'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'node_modules', '@expo', 'ngrok', 'package.json'),
      JSON.stringify({ name: '@expo/ngrok', version: '4.1.0' }),
    );
    expect(ngrokResolvesFrom(dir)).toBe(true);
    expect(EXPO_NGROK_SPEC).toBe('@expo/ngrok@^4.1.0');
  });
});
