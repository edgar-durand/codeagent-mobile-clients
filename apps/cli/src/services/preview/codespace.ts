import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

/**
 * Detect whether the CLI is running inside a GitHub Codespace. The
 * `CODESPACE_NAME` env var is set by codespaces on every shell.
 */
export function isCodespaceSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CODESPACE_NAME);
}

/** Construct the public forwarded-port URL GitHub Codespaces exposes. */
export function buildCodespaceUrl(codespaceName: string, port: number): string {
  return `https://${codespaceName}-${port}.app.github.dev`;
}

/**
 * Flip a forwarded port to `public` visibility so the URL works from
 * outside GitHub's auth gateway (mobile WebView / phone browser).
 * Runs `gh codespace ports visibility <port>:public -c <name>`; the
 * `gh` CLI is always present in codespaces.
 */
export async function setPortPublic(codespaceName: string, port: number): Promise<void> {
  await execFileP('gh', [
    'codespace',
    'ports',
    'visibility',
    `${port}:public`,
    '-c',
    codespaceName,
  ]);
}

/**
 * Ping the forwarded URL until it returns a non-5xx status, or
 * timeout. GitHub sometimes takes a few seconds after bind before the
 * forwarded port responds — without this gate the WebView shows the
 * codespace's "loading…" gateway page instead of the dev server.
 */
export async function waitForCodespacePortReady(
  url: string,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.status < 500) return;
    } catch {
      // network blip — keep retrying within the deadline
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Codespace forwarded URL ${url} not reachable after ${timeoutMs}ms.`);
}
