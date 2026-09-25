/**
 * The agent's door into the Preview (`codeagent_preview` MCP tools → bridge).
 *
 * What must hold:
 *   - it runs the Preview BUTTON's pipeline (resolvePreviewDetection →
 *     startPreviewFromDetection), tagged `origin: 'agent'`, with no confirm step;
 *   - the tool call gets the URL back, or the exact error;
 *   - two calls never start two dev servers;
 *   - a slow bring-up answers "still starting" instead of hanging the agent;
 *   - highlights only go out for a running, inspectable preview;
 *   - the loopback port refuses anyone without the token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPost, mockResolve, mockStart } = vi.hoisted(() => ({
  mockPost: vi.fn().mockResolvedValue({ ok: true }),
  mockResolve: vi.fn(),
  mockStart: vi.fn(),
}));

vi.mock('../../src/services/pairing.service', () => ({ postPreviewEvent: mockPost }));
vi.mock('../../src/commands/start/handlers', () => ({
  resolvePreviewDetection: mockResolve,
  startPreviewFromDetection: mockStart,
}));

import { activePreviews, type ActivePreview } from '../../src/services/preview';
import { AgentPreviewBridge } from '../../src/commands/start/agent-preview-bridge';
import type { RuntimeStrategy } from '../../src/agents/strategy';

const SESSION = 'sess-1';
const DETECTION = {
  framework: 'next',
  command: 'npm',
  args: ['run', 'dev'],
  port: 3000,
  ready_pattern: 'Ready',
};

function attach(bridge: AgentPreviewBridge): void {
  bridge.attach({
    sessionId: SESSION,
    pluginId: 'plug-1',
    pluginAuthToken: 'tok',
    getRuntime: () => ({ id: 'claude' }) as RuntimeStrategy,
  });
}

function register(overrides: Partial<ActivePreview> = {}): void {
  activePreviews.set(SESSION, {
    sessionId: SESSION,
    devServer: null,
    tunnel: null,
    url: 'https://p.preview.codeagent-mobile.com',
    framework: 'next',
    detection: DETECTION,
    cwd: '/tmp',
    inspector: { close: async () => undefined },
    ...overrides,
  });
}

function posted(type: string): Array<Record<string, unknown>> {
  return mockPost.mock.calls
    .map((c) => c[0] as { type: string; payload?: Record<string, unknown> })
    .filter((a) => a.type === type)
    .map((a) => a.payload ?? {});
}

let bridge: AgentPreviewBridge;
beforeEach(() => {
  mockPost.mockClear();
  mockResolve.mockReset();
  mockStart.mockReset();
  activePreviews.clear();
  bridge = new AgentPreviewBridge();
});
afterEach(() => {
  bridge.close();
  activePreviews.clear();
});

describe('start_preview', () => {
  it('refuses before the session is attached', async () => {
    const r = await bridge.start();
    expect(r).toMatchObject({ status: 'error', stage: 'session' });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('runs the button pipeline tagged origin:agent and returns the URL', async () => {
    attach(bridge);
    mockResolve.mockResolvedValue(DETECTION);
    mockStart.mockImplementation(async () => register());

    const r = await bridge.start();

    expect(r).toEqual({
      status: 'running',
      url: 'https://p.preview.codeagent-mobile.com',
      framework: 'next',
      inspector: true,
    });
    // First frame straight away, so the chat card appears during detection.
    expect(posted('preview_detection_pending')).toEqual([{ origin: 'agent' }]);
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ origin: 'agent' }));
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION }),
      DETECTION,
      'tok',
      expect.objectContaining({ origin: 'agent' }),
    );
  });

  it('an agent-supplied command skips detection', async () => {
    attach(bridge);
    mockStart.mockImplementation(async () => register());
    await bridge.start({ command: 'npm', args: ['start'], port: 8080 });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockStart.mock.calls[0][1]).toMatchObject({ command: 'npm', args: ['start'], port: 8080 });
  });

  it('returns the pipeline error verbatim', async () => {
    attach(bridge);
    mockResolve.mockResolvedValue(DETECTION);
    mockStart.mockImplementation(async (_c, _d, _t, opts: { onEvent: (t: string, p: object) => void }) => {
      opts.onEvent('preview_error', { stage: 'ready_timeout', message: 'dev server never became ready' });
    });
    const r = await bridge.start();
    expect(r).toEqual({ status: 'error', stage: 'ready_timeout', message: 'dev server never became ready' });
    expect(bridge.status()).toEqual(r);
  });

  it('a failed detection is an error, not a hang', async () => {
    attach(bridge);
    mockResolve.mockResolvedValue(null);
    const r = await bridge.start();
    expect(r).toMatchObject({ status: 'error', stage: 'detection' });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('two concurrent calls share ONE bring-up', async () => {
    attach(bridge);
    mockResolve.mockResolvedValue(DETECTION);
    let finish: () => void = () => undefined;
    mockStart.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            register();
            resolve();
          };
        }),
    );
    const a = bridge.start();
    const b = bridge.start();
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1));
    finish();
    const [ra, rb] = await Promise.all([a, b]);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(ra).toMatchObject({ status: 'running' });
    expect(rb).toMatchObject({ status: 'running' });
  });

  it('answers "starting" when the bring-up outlasts the wait, and keeps going', async () => {
    attach(bridge);
    mockResolve.mockResolvedValue(DETECTION);
    let finish: () => void = () => undefined;
    mockStart.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            register();
            resolve();
          };
        }),
    );
    const r = await bridge.start(undefined, 20);
    expect(r).toMatchObject({ status: 'starting' });
    expect(bridge.status()).toMatchObject({ status: 'starting' });
    finish();
    await vi.waitFor(() => expect(bridge.status()).toMatchObject({ status: 'running' }));
  });

  it('reuses a running preview and still announces it so the app switches', async () => {
    attach(bridge);
    register();
    const r = await bridge.start();
    expect(r).toMatchObject({ status: 'running', reused: true });
    expect(mockStart).not.toHaveBeenCalled();
    expect(posted('preview_ready')).toEqual([
      expect.objectContaining({ url: 'https://p.preview.codeagent-mobile.com', origin: 'agent' }),
    ]);
  });
});

describe('highlight_element', () => {
  it('needs a running preview', async () => {
    attach(bridge);
    const r = await bridge.highlight({ selector: '#cta' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/start_preview/);
  });

  it('needs the web inspector (Expo has none)', async () => {
    attach(bridge);
    register({ inspector: null, framework: 'expo' });
    const r = await bridge.highlight({ selector: '#cta' });
    expect(r.ok).toBe(false);
    expect(posted('preview_agent_highlight')).toHaveLength(0);
  });

  it('rejects an empty or oversized selector', async () => {
    attach(bridge);
    register();
    expect((await bridge.highlight({ selector: '  ' })).ok).toBe(false);
    expect((await bridge.highlight({ selector: 'a'.repeat(501) })).ok).toBe(false);
    expect(posted('preview_agent_highlight')).toHaveLength(0);
  });

  it('publishes the mark (label trimmed to 80) and the clear', async () => {
    attach(bridge);
    register();
    expect((await bridge.highlight({ selector: '#cta', label: 'x'.repeat(120) })).ok).toBe(true);
    expect((await bridge.highlight({ clear: true })).ok).toBe(true);
    expect(posted('preview_agent_highlight')).toEqual([
      { selector: '#cta', label: 'x'.repeat(80) },
      { clear: true },
    ]);
  });
});

describe('loopback transport', () => {
  it('rejects a request without the token and serves one with it', async () => {
    attach(bridge);
    const addr = await bridge.listen();
    expect(addr?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const denied = await fetch(`${addr!.url}/preview/status`);
    expect(denied.status).toBe(401);
    const wrong = await fetch(`${addr!.url}/preview/status`, { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${addr!.url}/preview/status`, {
      headers: { authorization: `Bearer ${addr!.token}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'idle' });
    expect(bridge.address()).toEqual(addr);
  });
});
