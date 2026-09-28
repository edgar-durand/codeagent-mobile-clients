import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prepareScratchWorkspace, isScratchWorkspace } from '../../src/scratch/workspace';

let home: string;
const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-scratch-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env.HOME = prev.HOME;
  process.env.USERPROFILE = prev.USERPROFILE;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('prepareScratchWorkspace', () => {
  it('creates ~/.codeam/self-hosted/<deployId> as a git repo with marker, .gitignore and one commit', async () => {
    const dir = await prepareScratchWorkspace('dep123');
    expect(dir).toBe(path.join(home, '.codeam', 'self-hosted', 'dep123'));
    expect(isScratchWorkspace(dir)).toBe(true);
    const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^node_modules\/$/m);
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^!\.env\.example$/m);
    expect(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD']).toString().trim()).toBe(
      '1',
    );
  });

  it('is idempotent on a retried deploy', async () => {
    await prepareScratchWorkspace('dep123');
    await expect(prepareScratchWorkspace('dep123')).resolves.toBeTruthy();
  });

  it('a normal clone dir is not scratch', () => {
    expect(isScratchWorkspace(home)).toBe(false);
  });
});
