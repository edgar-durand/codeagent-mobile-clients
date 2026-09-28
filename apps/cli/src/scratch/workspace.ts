import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { selfHostedWorkspaceRoot, nonInteractiveGitEnv } from '../commands/host/workspace';

const run = promisify(execFile);
export const SCRATCH_MARKER = 'codeam-scratch';

const GITIGNORE = [
  'node_modules/',
  '.env',
  '.env.*',
  '!.env.example',
  'dist/',
  'build/',
  '.next/',
  '.turbo/',
  '.cache/',
  '.DS_Store',
  '',
].join('\n');

/**
 * A repo-less "Start from scratch" project (spec 2026-09-28). It lives under
 * the self-hosted root on purpose: deployIdFromWorkspace, resume and
 * self_hosted_cleanup only understand ~/.codeam/self-hosted/<deployId>.
 * The marker sits inside .git so it is never part of the user's tree.
 */
export async function prepareScratchWorkspace(deployId: string): Promise<string> {
  const dir = path.join(selfHostedWorkspaceRoot(), deployId);
  const env = { ...process.env, ...nonInteractiveGitEnv() };
  if (isScratchWorkspace(dir)) return dir;
  fs.mkdirSync(dir, { recursive: true });
  await run('git', ['init', '-b', 'main', dir], { env });
  fs.writeFileSync(path.join(dir, '.gitignore'), GITIGNORE);
  // A local identity so the agent's own commits work before GitHub is linked;
  // save-to-GitHub replaces it with the user's.
  await run('git', ['-C', dir, 'config', 'user.name', 'CodeAgent'], { env });
  await run('git', ['-C', dir, 'config', 'user.email', 'noreply@codeagent-mobile.com'], { env });
  await run('git', ['-C', dir, 'add', '.gitignore'], { env });
  await run('git', ['-C', dir, 'commit', '-m', 'Start project'], { env });
  fs.writeFileSync(path.join(dir, '.git', SCRATCH_MARKER), '');
  return dir;
}

export function isScratchWorkspace(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, '.git', SCRATCH_MARKER));
}
