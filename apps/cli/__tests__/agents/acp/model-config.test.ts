import { describe, expect, it, vi } from 'vitest';
import { getContextWindow } from '@codeam/shared';
import { AcpClient, flattenSelectOptions } from '../../../src/agents/acp/client';
import type { AcpClientOptions } from '../../../src/agents/acp/client';

/**
 * Native-ACP model contract (the single source of truth). Model listing and
 * switching go through the agent's OWN `category:'model'` SessionConfigSelect
 * config option — captured from `newSession`/`loadSession` `configOptions` and
 * mutated via the native `session/set_config_option` RPC. There is NO hardcoded
 * per-agent model list and NO PTY `/model` command anywhere on the ACP path.
 *
 * These tests drive the pure capture/read/write surface directly (casting to
 * internals, the same pattern as load-session-guard.test.ts) so they don't need
 * to spawn a real adapter process.
 */

function makeClient(overrides?: Partial<AcpClientOptions>): AcpClient {
  const opts: AcpClientOptions = {
    adapter: {} as unknown as AcpClientOptions['adapter'],
    cwd: '/tmp/work',
    onSessionUpdate: () => undefined,
    onRequestPermission: (async () => ({
      outcome: { outcome: 'cancelled' },
    })) as unknown as AcpClientOptions['onRequestPermission'],
    ...overrides,
  };
  return new AcpClient(opts);
}

// The subset of AcpClient internals these tests reach into. `captureModelConfig`
// is the private parser normally invoked from startOnce/loadSession; exercising
// it directly is how we cover the newSession-capture mapping without a process.
interface ClientInternals {
  captureModelConfig: (configOptions: unknown[]) => void;
  captureModes: (modes: unknown) => void;
  connection:
    | {
        setSessionConfigOption?: ReturnType<typeof vi.fn>;
        setSessionMode?: ReturnType<typeof vi.fn>;
      }
    | null;
  sessionId: string | null;
  modelConfigId: string | undefined;
}

// A native model-select config option (flat options) with a current value.
const MODEL_SELECT_OPTION = {
  id: 'model',
  name: 'Model',
  category: 'model' as const,
  type: 'select' as const,
  currentValue: 'claude-opus-4-8',
  options: [
    { value: 'claude-opus-4-8', name: 'Opus 4.8' },
    { value: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
  ],
};

// A non-model option that must be ignored by the model capture.
const MODE_SELECT_OPTION = {
  id: 'mode',
  name: 'Mode',
  category: 'mode' as const,
  type: 'select' as const,
  currentValue: 'code',
  options: [{ value: 'code', name: 'Code' }],
};

describe('AcpClient — native model config capture (list_models source)', () => {
  it('maps the category:model select to available models (id=value, label=name, contextWindow by id) + current', () => {
    const client = makeClient();
    (client as unknown as ClientInternals).captureModelConfig([
      MODE_SELECT_OPTION,
      MODEL_SELECT_OPTION,
    ]);

    expect(client.getAvailableModels()).toEqual([
      {
        id: 'claude-opus-4-8',
        label: 'Opus 4.8',
        contextWindow: getContextWindow('claude-opus-4-8'),
      },
      {
        id: 'claude-sonnet-4-6',
        label: 'Sonnet 4.6',
        contextWindow: getContextWindow('claude-sonnet-4-6'),
      },
    ]);
    expect(client.getCurrentModelId()).toBe('claude-opus-4-8');
  });

  it('returns an EMPTY list + undefined current when the agent has no model config option (mobile hides the picker)', () => {
    const client = makeClient();
    // Only a non-model option present → no native model selector.
    (client as unknown as ClientInternals).captureModelConfig([MODE_SELECT_OPTION]);

    expect(client.getAvailableModels()).toEqual([]);
    expect(client.getCurrentModelId()).toBeUndefined();
  });

  it('flattens grouped select options (SessionConfigSelectGroup[]) into one flat model list', () => {
    const client = makeClient();
    (client as unknown as ClientInternals).captureModelConfig([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'gpt-5',
        options: [
          { group: 'openai', name: 'OpenAI', options: [{ value: 'gpt-5', name: 'GPT-5' }] },
          {
            group: 'anthropic',
            name: 'Anthropic',
            options: [{ value: 'claude-opus-4-8', name: 'Opus 4.8' }],
          },
        ],
      },
    ]);

    expect(client.getAvailableModels().map((m) => m.id)).toEqual(['gpt-5', 'claude-opus-4-8']);
    expect(client.getCurrentModelId()).toBe('gpt-5');
  });
});

describe('AcpClient.setModel — native session/set_config_option', () => {
  it('sends set_session_config_option with the captured model configId + selected value, and tracks current', async () => {
    const client = makeClient();
    const internals = client as unknown as ClientInternals;
    // Capture a model option so modelConfigId is populated (as after newSession).
    internals.captureModelConfig([MODEL_SELECT_OPTION]);
    const setSessionConfigOption = vi.fn().mockResolvedValue({ configOptions: [] });
    internals.connection = { setSessionConfigOption };
    internals.sessionId = 'sess-1';

    await client.setModel('claude-sonnet-4-6');

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      configId: 'model', // the native model config option id, NOT a PTY /model
      value: 'claude-sonnet-4-6',
    });
    expect(client.getCurrentModelId()).toBe('claude-sonnet-4-6'); // tracked on success
  });

  it('throws "model selection not available" when the agent exposes no model config option (change_model → failed → mobile shows unsupported)', async () => {
    const client = makeClient();
    const internals = client as unknown as ClientInternals;
    // No model option captured → modelConfigId stays undefined.
    internals.captureModelConfig([MODE_SELECT_OPTION]);
    const setSessionConfigOption = vi.fn().mockResolvedValue({ configOptions: [] });
    internals.connection = { setSessionConfigOption };
    internals.sessionId = 'sess-1';

    await expect(client.setModel('whatever')).rejects.toThrow(/model selection not available/i);
    expect(setSessionConfigOption).not.toHaveBeenCalled(); // no native option to target
  });
});

// A native SessionModeState (the DIFFERENT axis from models) with a current mode.
const MODE_STATE = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default', description: 'Normal editing' },
    { id: 'plan', name: 'Plan', description: null },
    { id: 'acceptEdits', name: 'Accept Edits' },
  ],
};

describe('AcpClient — native session-mode capture (list_modes source)', () => {
  it('maps SessionModeState.availableModes to AgentMode[] (id, label=name, description) + current', () => {
    const client = makeClient();
    (client as unknown as ClientInternals).captureModes(MODE_STATE);

    expect(client.getAvailableModes()).toEqual([
      { id: 'default', label: 'Default', description: 'Normal editing' },
      { id: 'plan', label: 'Plan', description: undefined },
      { id: 'acceptEdits', label: 'Accept Edits', description: undefined },
    ]);
    expect(client.getCurrentModeId()).toBe('default');
  });

  it('returns an EMPTY list + undefined current when the agent advertises no modes (mobile hides the picker)', () => {
    const client = makeClient();
    (client as unknown as ClientInternals).captureModes(null);

    expect(client.getAvailableModes()).toEqual([]);
    expect(client.getCurrentModeId()).toBeUndefined();
  });
});

describe('AcpClient.setMode — native session/set_mode', () => {
  it('sends set_session_mode with the selected modeId and tracks current on success', async () => {
    const client = makeClient();
    const internals = client as unknown as ClientInternals;
    // Capture modes so availableModes is populated (as after newSession).
    internals.captureModes(MODE_STATE);
    const setSessionMode = vi.fn().mockResolvedValue({});
    internals.connection = { setSessionMode };
    internals.sessionId = 'sess-1';

    await client.setMode('plan');

    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      modeId: 'plan',
    });
    expect(client.getCurrentModeId()).toBe('plan'); // tracked on success
  });

  it('throws "mode selection not available" when the agent advertises no modes (set_mode → failed → mobile shows unsupported)', async () => {
    const client = makeClient();
    const internals = client as unknown as ClientInternals;
    // No modes captured → availableModes stays empty.
    internals.captureModes(null);
    const setSessionMode = vi.fn().mockResolvedValue({});
    internals.connection = { setSessionMode };
    internals.sessionId = 'sess-1';

    await expect(client.setMode('whatever')).rejects.toThrow(/mode selection not available/i);
    expect(setSessionMode).not.toHaveBeenCalled(); // no native modes to target
  });
});

describe('flattenSelectOptions', () => {
  it('passes a flat option array through unchanged', () => {
    expect(
      flattenSelectOptions([
        { value: 'a', name: 'A' },
        { value: 'b', name: 'B' },
      ]),
    ).toEqual([
      { value: 'a', name: 'A' },
      { value: 'b', name: 'B' },
    ]);
  });

  it('splices group options in order', () => {
    expect(
      flattenSelectOptions([
        { group: 'g1', name: 'G1', options: [{ value: 'a', name: 'A' }] },
        {
          group: 'g2',
          name: 'G2',
          options: [
            { value: 'b', name: 'B' },
            { value: 'c', name: 'C' },
          ],
        },
      ]),
    ).toEqual([
      { value: 'a', name: 'A' },
      { value: 'b', name: 'B' },
      { value: 'c', name: 'C' },
    ]);
  });
});
