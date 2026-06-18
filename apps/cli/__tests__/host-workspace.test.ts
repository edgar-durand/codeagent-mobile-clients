import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Capture the args/options every `git clone` is invoked with. `execFile` is
// promisified inside workspace.ts, so the mock must follow the
// (file, args, options, callback) Node signature.
const execFileCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
let execFileBehavior: 'ok' | 'fail' = 'ok';

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    execFileCalls.push({ file, args, options });
    if (execFileBehavior === 'fail') {
      // Surface the full clone URL in the error so we can prove it gets masked.
      const url = args[args.length - 2];
      callback(new Error(`fatal: could not read from ${url}`), { stdout: '', stderr: '' });
      return;
    }
    // Simulate a successful clone by creating the dest .git dir.
    const dest = args[args.length - 1];
    fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
    callback(null, { stdout: '', stderr: '' });
  },
}));

import {
  prepareWorkspace,
  repoCloneUrl,
  isAbsolutePathTarget,
} from '../src/commands/host/workspace';

let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(() => {
  execFileCalls.length = 0;
  execFileBehavior = 'ok';
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-home-'));
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserProfile;
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('repoCloneUrl — token embedding', () => {
  it('embeds an x-access-token URL for a GitHub owner/repo when a token is present', () => {
    expect(repoCloneUrl('owner/repo', 'ghs_TOKEN')).toBe(
      'https://x-access-token:ghs_TOKEN@github.com/owner/repo.git',
    );
  });

  it('embeds the token into a https github.com URL too', () => {
    expect(repoCloneUrl('https://github.com/owner/repo.git', 'ghs_TOKEN')).toBe(
      'https://x-access-token:ghs_TOKEN@github.com/owner/repo.git',
    );
  });

  it('falls back to a plain https URL with no token', () => {
    expect(repoCloneUrl('owner/repo')).toBe('https://github.com/owner/repo.git');
  });

  it('does not embed a token for a non-GitHub host', () => {
    expect(repoCloneUrl('https://gitlab.com/owner/repo.git', 'ghs_TOKEN')).toBe(
      'https://gitlab.com/owner/repo.git',
    );
  });
});

describe('prepareWorkspace — clone auth + no-hang env', () => {
  it('clones with the token-bearing URL AND a non-interactive git env when cloneToken is present', async () => {
    await prepareWorkspace('owner/repo', 'deploy-A', 'ghs_TOKEN');

    expect(execFileCalls).toHaveLength(1);
    const call = execFileCalls[0];
    expect(call.file).toBe('git');
    // The clone URL is the token-bearing one.
    const url = call.args[call.args.length - 2];
    expect(url).toBe('https://x-access-token:ghs_TOKEN@github.com/owner/repo.git');

    // Non-interactive env so a bad/missing credential FAILS FAST, never hangs.
    const env = call.options.env as NodeJS.ProcessEnv;
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('');
    expect(env.GCM_INTERACTIVE).toBe('never');
  });

  it('still sets the non-interactive env when no cloneToken is supplied', async () => {
    await prepareWorkspace('owner/repo', 'deploy-B');

    const env = execFileCalls[0].options.env as NodeJS.ProcessEnv;
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('');
    expect(env.GCM_INTERACTIVE).toBe('never');
    // No token in the URL.
    const url = execFileCalls[0].args[execFileCalls[0].args.length - 2];
    expect(url).toBe('https://github.com/owner/repo.git');
  });

  it('masks the token in the error message when the clone fails (never logs the token)', async () => {
    execFileBehavior = 'fail';
    let thrown: Error | null = null;
    try {
      await prepareWorkspace('owner/repo', 'deploy-C', 'ghs_SUPERSECRET');
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    // The token must NOT appear anywhere in the surfaced error.
    expect(thrown!.message).not.toContain('ghs_SUPERSECRET');
    expect(thrown!.message).toContain('***');
    expect(thrown!.message).toContain('github.com/owner/repo.git');
  });

  it('returns an absolute path verbatim without cloning', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-abs-'));
    expect(isAbsolutePathTarget(dir)).toBe(true);
    const result = await prepareWorkspace(dir, 'deploy-D', 'ghs_TOKEN');
    expect(result).toBe(dir);
    expect(execFileCalls).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reuses an existing clone for the same deployId (idempotent, no re-clone)', async () => {
    await prepareWorkspace('owner/repo', 'deploy-E', 'ghs_TOKEN');
    expect(execFileCalls).toHaveLength(1);
    // Second call for the same deployId finds the .git dir and skips cloning.
    await prepareWorkspace('owner/repo', 'deploy-E', 'ghs_TOKEN');
    expect(execFileCalls).toHaveLength(1);
  });
});
