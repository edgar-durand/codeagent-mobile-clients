/**
 * Expo preview on a Box, THE 2026-09-05 failure: `expo start --tunnel`
 * spawned without a TTY prints only `Waiting on http://localhost:8081` —
 * never the `exp://` line (that belongs to Expo's interactive UI) — and the
 * old parser looked for `exp.host` when modern tunnels are `exp.direct`.
 * Result: ERR_READY_TIMEOUT on every Expo preview, tunnel up and unused.
 *
 * Verified live on the reporting user's box (Rafael, expo-test): with
 * `DEBUG=expo:start:server:ngrok` Expo emits
 *   `expo:start:server:ngrok Tunnel URL: https://lfe07au-anonymous-8091.exp.direct`
 * on stderr. This suite drives the REAL orchestrator with a fake dev server
 * that prints exactly that (real child process, real pipes) and asserts:
 *   1. the spawn env carries the debug channel,
 *   2. readiness fires on the debug line (not on the AI's `ready_pattern`),
 *   3. preview_ready carries the `exp://…exp.direct` deep link.
 */
import { spawn as realSpawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as preview from '../../src/services/preview';
import { runPreviewStart } from '../../src/services/preview/start-orchestrator';
import type { PreviewDetection } from '@codeam/shared';

const spawnCalls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return {
    ...actual,
    default: actual,
    spawn: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ cmd, args, env: opts.env });
      // Stand in for `expo start --tunnel` with EXACTLY the non-TTY output
      // observed on the box: stdout has no exp:// URL; stderr carries the
      // debug line (only because DEBUG requests the channel).
      const debugOn = (opts.env.DEBUG ?? '').includes('expo:start:server:ngrok');
      const script = `
        const out = (s) => process.stdout.write(s + '\\n');
        const err = (s) => process.stderr.write(s + '\\n');
        setTimeout(() => {
          out('Starting project at /home/box/.codeam/self-hosted/x');
          out('Starting Metro Bundler');
          ${debugOn ? "err('2026-09-05T22:50:21.673Z expo:start:server:ngrok Hostname: lFe07AU-anonymous-8081.exp.direct');" : ''}
          out('Tunnel connected.');
          ${debugOn ? "err('2026-09-05T22:50:22.280Z expo:start:server:ngrok Tunnel URL: https://lfe07au-anonymous-8081.exp.direct');" : ''}
          out('Tunnel ready.');
          out('Waiting on http://localhost:8081');
          setInterval(() => {}, 1000);
        }, 100);`;
      return actual.spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    },
  };
});

// The detection the agent wrote for Rafael's repo — its ready_pattern
// ("Metro waiting") is interactive-UI copy a non-TTY Expo never prints.
const detection: PreviewDetection = {
  framework: 'Expo',
  command: 'npx',
  args: ['expo', 'start', '--tunnel'],
  port: 8081,
  ready_pattern: 'Metro waiting',
  env: { HOST: '0.0.0.0' },
  setup_commands: [],
};

beforeEach(() => {
  spawnCalls.length = 0;
  vi.spyOn(process, 'cwd').mockReturnValue('/tmp/fake-expo');
  vi.spyOn(preview, 'detectMissingNodeDeps').mockReturnValue(null);
  vi.spyOn(preview, 'isPortListening').mockResolvedValue(false);
  vi.spyOn(preview, 'ensureExpoTunnelDeps').mockResolvedValue({ ok: true, code: 0, installed: false });
});
afterEach(() => {
  for (const p of preview.activePreviews.values()) {
    try { p.devServer?.kill('SIGKILL'); } catch { /* gone */ }
  }
  preview.activePreviews.clear();
  vi.restoreAllMocks();
});

describe('Expo preview without a TTY (the Box case)', () => {
  it('spawns Expo with the ngrok debug channel, goes READY on its Tunnel URL line, and publishes the exp.direct deep link', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    await runPreviewStart({
      sessionId: 'sess-expo',
      detection,
      cwd: '/tmp/fake-expo',
      emit: ((type: string, payload: Record<string, unknown>) => {
        events.push({ type, payload });
      }) as never,
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].env.DEBUG).toContain('expo:start:server:ngrok');

    const ready = events.find((e) => e.type.endsWith('preview_ready'));
    const error = events.find((e) => e.type.endsWith('preview_error'));
    expect(error, JSON.stringify(error?.payload)).toBeUndefined();
    expect(ready?.payload.url).toBe('exp://lfe07au-anonymous-8081.exp.direct');
    expect(ready?.payload.framework).toBe('Expo');
  }, 30_000);
});
