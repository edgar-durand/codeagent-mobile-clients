import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Push the working repo to `cloneUrl` FROM A CLEAN BARE COPY, with the
 * credential delivered ONLY as an env-configured HTTP header on the push child
 * (never argv, never a URL, never a file). Shared by the GitHub and GitLab
 * saves — the provider only changes how the header is built.
 *
 * Why the copy: the agent writes into the working repo (credential helpers,
 * hooks, includes…), so the token-carrying push runs against a bare clone made
 * with an empty template, no system/global config and a throwaway HOME, and
 * refuses to run if that copy still carries any http/url/credential/include
 * config (an agent-written `init.templateDir` route, caught in review).
 */
export async function pushCleanCopy(
  cwd: string,
  cloneUrl: string,
  authorizationHeader: string,
  deps: { exec?: typeof execFile; env: NodeJS.ProcessEnv },
): Promise<void> {
  const exec = promisify(deps.exec ?? execFile);
  let tmp: string | undefined;
  let home: string | undefined;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-push-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-push-home-'));
    const bare = path.join(tmp, 'repo.git');
    const cleanEnv = {
      ...withoutInheritedGitConfig(deps.env),
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    };
    await exec('git', ['clone', '--bare', '--no-hardlinks', '--template=', '-q', cwd, bare], {
      env: cleanEnv,
    });
    const { stdout: keys } = await exec(
      'git',
      ['-C', bare, 'config', '--local', '--list', '--name-only'],
      {
        env: cleanEnv,
      },
    );
    const hostile = keys
      .split('\n')
      .filter((k) => /^(http|url|credential|include|includeif)\./i.test(k));
    if (hostile.length > 0) {
      throw new Error(`the clean copy carries unexpected git config (${hostile.join(', ')})`);
    }
    const pushEnv = {
      ...cleanEnv,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${cloneUrl}.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: ${authorizationHeader}`,
    };
    await exec(
      'git',
      [
        '-C',
        bare,
        '-c',
        'credential.helper=',
        '-c',
        'credential.interactive=never',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'http.sslVerify=true',
        '-c',
        'http.proxy=',
        // git ranks a URL-matched http.<url>.* key above the generic one, so a
        // key written into the bare config after the check above would still
        // win without these exact-URL overrides (command line is read last).
        '-c',
        `http.${cloneUrl}.sslVerify=true`,
        '-c',
        `http.${cloneUrl}.proxy=`,
        'push',
        cloneUrl,
        'HEAD:main',
      ],
      { env: pushEnv },
    );
  } catch (err) {
    throw Object.assign(new Error(`Push failed: ${(err as Error).message.split('\n')[0]}`), {
      code: 'SAVE_FAILED',
    });
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * The CLI's own env minus anything that injects git config or weakens TLS:
 * GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n
 * (an inherited `http.<url>.proxy` there would route the AUTHORIZATION header
 * through a proxy), GIT_SSL_NO_VERIFY (git reads it AFTER config, so
 * `-c http.sslVerify=true` cannot undo it), GIT_TRACE* (with
 * GIT_TRACE_REDACT=0 a curl trace writes the header to a file), and
 * GIT_DIR / GIT_WORK_TREE (would point git away from the bare copy).
 */
function withoutInheritedGitConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^GIT_(CONFIG|TRACE)/i.test(key)) continue;
    if (/^GIT_(SSL_NO_VERIFY|DIR|WORK_TREE)$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}
