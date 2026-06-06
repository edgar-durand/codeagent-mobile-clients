/**
 * Story — ACP start_task forwards mobile image attachments.
 *
 * QA report #290 (Android, 2026-06-06): mobile selected 3 images,
 * sent "Check this", and the ACP-backed agent replied that it saw
 * no attachments. The legacy PTY path stages payload.files as temp
 * files, but ACP start_task was forwarding prompt text only.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleCommand } from '../../src/agents/acp/runner';
import type { RemoteCommand } from '../../src/services/command-relay.service';

function makeHarness(agentCaps: {
  promptCapabilities?: { image?: boolean };
}) {
  const client = {
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
  };
  const relay = {
    sendResult: vi.fn().mockResolvedValue(undefined),
  };
  const streaming = {
    beginTurn: vi.fn().mockResolvedValue(undefined),
    getCurrentText: vi.fn(() => ''),
    closeTurnWithInteractiveDetection: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue(undefined),
  };
  const history = {
    appendUserPrompt: vi.fn(),
    appendAgentReply: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  };
  const turnFiles = {
    flushTurn: vi.fn().mockResolvedValue(undefined),
  };
  const opts = {
    agent: 'claude',
    sessionId: 'sess-1',
    pluginId: 'plug-1',
    pluginAuthToken: 'tok-1',
    cwd: '/repo',
    adapter: {
      command: 'node',
      args: [],
      requiresAgentBinary: 'claude',
    },
  };

  return { client, relay, streaming, history, turnFiles, opts, agentCaps };
}

async function dispatchStartTask(harness: ReturnType<typeof makeHarness>) {
  const cmd: RemoteCommand = {
    id: 'cmd-1',
    sessionId: 'sess-1',
    type: 'start_task',
    payload: {
      prompt: 'Check this',
      files: [
        {
          filename: 'one.png',
          mimeType: 'image/png',
          base64: 'iVBORw0KGgo=',
        },
        {
          filename: 'two.jpg',
          mimeType: 'image/jpeg',
          base64: '/9j/4AAQSkZJRg==',
        },
        {
          filename: 'three.webp',
          mimeType: 'image/webp',
          base64: 'UklGRiIAAABXRUJQVlA4',
        },
      ],
    },
  };

  await handleCommand(
    cmd,
    harness.client as never,
    harness.relay as never,
    'acp-sess-1',
    [],
    harness.streaming as never,
    harness.opts as never,
    harness.history as never,
    harness.agentCaps,
    harness.turnFiles as never,
  );
}

describe('story: ACP start_task / mobile image attachments', () => {
  it('forwards one ACP image block per payload file when the adapter supports images', async () => {
    const harness = makeHarness({ promptCapabilities: { image: true } });

    await dispatchStartTask(harness);

    expect(harness.client.prompt).toHaveBeenCalledTimes(1);
    expect(harness.client.prompt).toHaveBeenCalledWith({
      content: [
        { type: 'text', text: 'Check this' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        { type: 'image', mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' },
        { type: 'image', mimeType: 'image/webp', data: 'UklGRiIAAABXRUJQVlA4' },
      ],
      textForLog: 'Check this',
    });
    expect(harness.relay.sendResult).toHaveBeenCalledWith(
      'cmd-1',
      'completed',
      { stopReason: 'end_turn' },
    );
  });

  it("skips images and appends a visible note when the adapter doesn't support images", async () => {
    const harness = makeHarness({ promptCapabilities: { image: false } });

    await dispatchStartTask(harness);

    expect(harness.client.prompt).toHaveBeenCalledTimes(1);
    expect(harness.client.prompt).toHaveBeenCalledWith({
      content: [
        {
          type: 'text',
          text: "Check this\n\nAttachment ignored — adapter doesn't support images.",
        },
      ],
      textForLog: "Check this\n\nAttachment ignored — adapter doesn't support images.",
    });
  });
});
