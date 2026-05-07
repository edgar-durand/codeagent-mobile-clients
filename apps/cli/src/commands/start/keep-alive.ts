import { spawn } from 'child_process';

/**
 * "Avoid suspend codespace on inactivity" — implements the toggle
 * the apps' Settings modal exposes for paired GitHub Codespaces.
 *
 * Why the previous "ping the API" approach didn't work: GitHub's
 * inactivity detection counts INCOMING connections (VS Code Remote,
 * `gh codespace ssh`), not outgoing API calls from inside the VM.
 * So `gh codespace list` from inside the codespace doesn't reset
 * the idle timer — the workspace got suspended after 30 min of
 * "real" inactivity even with the toggle on.
 *
 * What actually works: bump the codespace's `idle_timeout_minutes`
 * via the GitHub API. Default is 30; max is 240 (org admins can
 * raise it). We set 240 when the toggle is on, reset to 30 when
 * it's off. We re-apply on a 30-min timer to absorb transient API
 * failures + clock skew — GitHub doesn't reset the idle clock on
 * PATCH, the call is idempotent.
 *
 * Beyond 240 min of true inactivity, the codespace stops anyway —
 * GitHub's design. The toggle gives 8× longer than default, not
 * infinite uptime.
 */

export interface KeepAliveContext {
  inCodespace: boolean;
  codespaceName: string | undefined;
}

export function buildKeepAlive(ctx: KeepAliveContext): {
  apply: (enabled: boolean) => void;
} {
  let timer: NodeJS.Timeout | null = null;

  async function setIdleTimeout(minutes: number): Promise<void> {
    if (!ctx.inCodespace || !ctx.codespaceName) return;
    await new Promise<void>((resolve) => {
      const proc = spawn(
        'gh',
        [
          'api',
          '-X', 'PATCH',
          `/user/codespaces/${ctx.codespaceName}`,
          '-F', `idle_timeout_minutes=${minutes}`,
        ],
        { stdio: 'ignore', detached: true },
      );
      proc.unref();
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
    });
  }

  return {
    apply(enabled: boolean): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (!ctx.inCodespace || !ctx.codespaceName) return;
      if (!enabled) {
        void setIdleTimeout(30);
        return;
      }
      void setIdleTimeout(240);
      timer = setInterval(() => { void setIdleTimeout(240); }, 30 * 60 * 1000);
    },
  };
}
