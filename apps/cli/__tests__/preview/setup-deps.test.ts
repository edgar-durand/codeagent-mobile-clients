import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectMissingNodeDeps,
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

  it('defaults to npm install when no lockfile is present', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(detectMissingNodeDeps(dir)).toEqual({ cmd: 'npm', args: ['install'] });
  });

  it('picks npm when package-lock.json is present', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    expect(detectMissingNodeDeps(dir)).toEqual({ cmd: 'npm', args: ['install'] });
  });

  it('picks pnpm when pnpm-lock.yaml is present', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    expect(detectMissingNodeDeps(dir)).toEqual({ cmd: 'pnpm', args: ['install'] });
  });

  it('picks yarn when yarn.lock is present', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    expect(detectMissingNodeDeps(dir)).toEqual({ cmd: 'yarn', args: ['install'] });
  });

  it('picks bun when bun.lockb is present', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'bun.lockb'), '');
    expect(detectMissingNodeDeps(dir)).toEqual({ cmd: 'bun', args: ['install'] });
  });

  it('picks bun when the text-format bun.lock is present', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'bun.lock'), '');
    expect(detectMissingNodeDeps(dir)).toEqual({ cmd: 'bun', args: ['install'] });
  });

  it('prefers pnpm over yarn when both lockfiles exist (corrupt repo state)', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    expect(detectMissingNodeDeps(dir)).toEqual({ cmd: 'pnpm', args: ['install'] });
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
