/**
 * Expo previews ride OUR cloudflared tunnel, not Expo's ngrok one.
 *
 * THE 2026-09-07 failure: `expo start --tunnel` authenticates ngrok with the
 * token hardcoded in `@expo/cli` — one account shared by every anonymous Expo
 * user. Whenever it sits at its 5000-session cap the ngrok agent exits
 * (`ERR_NGROK_108`), `@expo/ngrok` throws `Cannot read properties of undefined
 * (reading 'body')`, Expo exits 1 → `ERR_SPAWN_FAILED "dev server exited
 * (code 1)"`. Intermittent by construction (works whenever the shared account
 * dips under the cap), which a user experienced as "start after stop breaks".
 *
 * Validated end-to-end on the box image: run Expo WITHOUT `--tunnel`, put our
 * cloudflared in front of Metro, and hand Expo the public URL through
 * `EXPO_PACKAGER_PROXY_URL` (read BEFORE Expo starts — so the tunnel comes up
 * FIRST). The manifest then advertises the tunnel host and Expo Go opens it as
 * `exps://<host>`.
 *
 * This suite drives the REAL orchestrator with a mocked `child_process.spawn`
 * (real node children, real pipes) and asserts the order + the wiring. The last
 * case pins the NON-Expo order (dev server first, then tunnel) so the refactor
 * that made the tunnel stage reusable can't regress it.
 */
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as preview from '../../src/services/preview';
import { runPreviewStart } from '../../src/services/preview/start-orchestrator';
import type { PreviewDetection } from '@codeam/shared';

interface SpawnCall {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  child: ChildProcess;
}
const spawnCalls: SpawnCall[] = [];
/** What the fake dev server prints — set per test. */
let devServerScript = '';

vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return {
    ...actual,
    default: actual,
    spawn: (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      // cloudflared is recognised by its argv; everything else is the dev server.
      const isTunnel = args[0] === 'tunnel';
      const script = isTunnel ? 'setInterval(() => {}, 1000);' : devServerScript;
      const child = actual.spawn(process.execPath, ['-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      spawnCalls.push({ cmd, args, env: opts.env ?? {}, child });
      return child;
    },
  };
});

const EXPO_SERVES_METRO = `
  const out = (s) => process.stdout.write(s + '\\n');
  setTimeout(() => {
    out('Starting project at /home/box/.codeam/self-hosted/x');
    out('Starting Metro Bundler');
    out('Waiting on http://localhost:8081');
    out('Logs for your project will appear below. Press Ctrl+C to exit.');
    setInterval(() => {}, 1000);
  }, 100);`;

// The detection the agent wrote for the reporting user's repo — still carries
// `--tunnel` (older detections / saved `.codeam/preview.json` do), and a
// ready_pattern that non-TTY Expo never prints.
const expoDetection: PreviewDetection = {
  framework: 'Expo',
  command: 'npx',
  args: ['expo', 'start', '--tunnel'],
  port: 8081,
  ready_pattern: 'Metro waiting',
  env: { HOST: '0.0.0.0' },
  setup_commands: [],
};

function collectEvents() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    emit: (type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
    },
  };
}

let inspectorEnvBefore: string | undefined;
beforeEach(() => {
  spawnCalls.length = 0;
  devServerScript = EXPO_SERVES_METRO;
  // Keep the inspector proxy out of the non-Expo case: it's orthogonal here
  // and would open a real listener.
  inspectorEnvBefore = process.env.CODEAM_PREVIEW_INSPECTOR;
  process.env.CODEAM_PREVIEW_INSPECTOR = '0';
  vi.spyOn(process, 'cwd').mockReturnValue('/tmp/fake-expo');
  vi.spyOn(preview, 'detectMissingNodeDeps').mockReturnValue(null);
  vi.spyOn(preview, 'isPortListening').mockResolvedValue(false);
  vi.spyOn(preview, 'resolveCloudflared').mockResolvedValue('/fake/cloudflared');
  vi.spyOn(preview, 'awaitTunnelRegistered').mockResolvedValue({
    kind: 'registered',
    url: 'https://host.example',
  });
  vi.spyOn(preview, 'recordPreviewPort').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const c of spawnCalls) {
    try {
      c.child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
  preview.activePreviews.clear();
  if (inspectorEnvBefore === undefined) delete process.env.CODEAM_PREVIEW_INSPECTOR;
  else process.env.CODEAM_PREVIEW_INSPECTOR = inspectorEnvBefore;
  vi.restoreAllMocks();
});

describe('Expo preview over our own cloudflared tunnel', () => {
  it('brings the tunnel up FIRST, spawns Expo without --tunnel + with the proxy URL, and publishes exps://', async () => {
    const { events, emit } = collectEvents();
    await runPreviewStart({
      sessionId: 'sess-expo',
      detection: expoDetection,
      cwd: '/tmp/fake-expo',
      emit: emit as never,
    });

    const error = events.find((e) => e.type.endsWith('preview_error'));
    expect(error, JSON.stringify(error?.payload)).toBeUndefined();

    // Order: cloudflared before Expo — Expo reads EXPO_PACKAGER_PROXY_URL at
    // startup, so the public URL has to exist before Metro boots.
    expect(spawnCalls.map((c) => c.args[0])).toEqual(['tunnel', 'expo']);
    const [tunnel, expo] = spawnCalls;
    expect(tunnel.cmd).toBe('/fake/cloudflared');
    expect(tunnel.args).toEqual(['tunnel', '--url', 'http://localhost:8081']);

    expect(expo.args).not.toContain('--tunnel');
    expect(expo.args).toEqual(['expo', 'start', '--port', '8081']);
    expect(expo.env.EXPO_PACKAGER_PROXY_URL).toBe('https://host.example');
    // The detection's own env still rides along.
    expect(expo.env.HOST).toBe('0.0.0.0');
    // No ngrok debug channel any more — it existed only for `--tunnel`.
    expect(expo.env.DEBUG ?? '').not.toContain('expo:start:server:ngrok');

    const ready = events.find((e) => e.type.endsWith('preview_ready'));
    expect(ready?.payload).toEqual({ url: 'exps://host.example', framework: 'Expo', port: 8081 });

    // The tunnel is registered on the preview so `killPreview` tears it down.
    const active = preview.activePreviews.get('sess-expo');
    expect(active?.tunnel).toBe(tunnel.child);
    expect(active?.devServer).toBe(expo.child);
    expect(active?.url).toBe('exps://host.example');
  }, 30_000);

  it('goes READY on the local manifest probe when Expo prints nothing recognisable', async () => {
    devServerScript = `
      process.stdout.write('Starting Metro Bundler\\n');
      setInterval(() => {}, 1000);`;
    const manifest = vi.spyOn(preview, 'waitForExpoManifest').mockResolvedValue(true);

    const { events, emit } = collectEvents();
    await runPreviewStart({
      sessionId: 'sess-expo-manifest',
      detection: expoDetection,
      cwd: '/tmp/fake-expo',
      emit: emit as never,
    });

    expect(manifest).toHaveBeenCalledWith(
      8081,
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    const ready = events.find((e) => e.type.endsWith('preview_ready'));
    expect(ready?.payload.url).toBe('exps://host.example');
  }, 30_000);

  it('tears the tunnel down when Expo dies before it is ready', async () => {
    devServerScript = `
      process.stderr.write('CommandError: something exploded\\n');
      process.exit(1);`;

    const { events, emit } = collectEvents();
    await runPreviewStart({
      sessionId: 'sess-expo-dead',
      detection: expoDetection,
      cwd: '/tmp/fake-expo',
      emit: emit as never,
    });

    const error = events.find((e) => e.type.endsWith('preview_error'));
    expect(error?.payload.stage).toBe('spawn');
    expect(String(error?.payload.message)).toContain('exited (code 1)');
    expect(events.some((e) => e.type.endsWith('preview_ready'))).toBe(false);

    // The cloudflared child we brought up first must not be leaked.
    const tunnel = spawnCalls.find((c) => c.args[0] === 'tunnel')!;
    await new Promise<void>((r) => {
      if (tunnel.child.exitCode !== null || tunnel.child.signalCode) return r();
      tunnel.child.once('exit', () => r());
    });
    expect(tunnel.child.signalCode ?? tunnel.child.exitCode).not.toBeNull();
    expect(preview.activePreviews.has('sess-expo-dead')).toBe(false);
  }, 30_000);
});

describe('non-Expo previews keep the original order', () => {
  it('spawns the dev server FIRST and the tunnel after readiness', async () => {
    devServerScript = `
      setTimeout(() => {
        process.stdout.write('  ▲ Next.js 14.2\\n  - Local: http://localhost:3000\\n  ✓ Ready in 1.2s\\n');
        setInterval(() => {}, 1000);
      }, 100);`;
    const detection: PreviewDetection = {
      framework: 'Next.js',
      command: 'npm',
      args: ['run', 'dev'],
      port: 3000,
      ready_pattern: 'Ready in',
    };

    const { events, emit } = collectEvents();
    await runPreviewStart({
      sessionId: 'sess-next',
      detection,
      cwd: '/tmp/fake-expo',
      emit: emit as never,
    });

    const error = events.find((e) => e.type.endsWith('preview_error'));
    expect(error, JSON.stringify(error?.payload)).toBeUndefined();
    expect(spawnCalls.map((c) => c.args[0])).toEqual(['run', 'tunnel']);
    expect(spawnCalls[0].args).toEqual(['run', 'dev']);
    expect(spawnCalls[0].env.EXPO_PACKAGER_PROXY_URL).toBeUndefined();
    expect(spawnCalls[1].args).toEqual(['tunnel', '--url', 'http://localhost:3000']);

    const ready = events.find((e) => e.type.endsWith('preview_ready'));
    expect(ready?.payload).toEqual({
      url: 'https://host.example',
      framework: 'Next.js',
      port: 3000,
    });
  }, 30_000);
});
