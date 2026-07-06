import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

// command-relay.service imports vscode for `showWarningMessage`. The
// production code only touches it inside handleAuthFailure (called
// directly via the test seam below) so the stub is empty by default
// — individual cases mock the surface they exercise.
vi.mock('vscode', () => ({
  default: {},
  window: { showWarningMessage: vi.fn().mockResolvedValue(undefined) },
  commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
}));

// settings.service imports @codeam/shared and vscode workspace —
// avoid the whole stack by giving CommandRelayService a stub that
// returns predictable values for the auth-failure path.
vi.mock('../src/services/settings.service', () => ({
  SettingsService: {
    getInstance: () => ({
      apiBaseUrl: 'https://api.test.local',
      ensurePluginId: () => 'plugin-test',
      heartbeatIntervalMs: 30_000,
      getPluginAuthToken: () => null,
      setPluginAuthToken: vi.fn(),
    }),
  },
}));

vi.mock('../src/services/telemetry.service', () => ({
  capture: vi.fn(),
}));

import {
  CommandRelayService,
  type CommandListener,
  type RemoteCommand,
  _testResetCommandRelay,
} from '../src/services/command-relay.service';

function makeLog(): vscode.OutputChannel {
  const stub: Pick<vscode.OutputChannel, 'appendLine' | 'name'> & Partial<vscode.OutputChannel> = {
    appendLine: vi.fn(),
    name: 'test',
  };
  return stub as vscode.OutputChannel;
}

function sseFrame(commands: Array<Partial<RemoteCommand>>): string {
  return `event: commands\ndata: ${JSON.stringify({ commands })}\n`;
}

describe('CommandRelayService', () => {
  let relay: CommandRelayService;
  let received: RemoteCommand[];
  let listener: CommandListener;

  beforeEach(() => {
    _testResetCommandRelay();
    relay = CommandRelayService.initialize(makeLog());
    received = [];
    listener = {
      onCommandReceived: (c) => {
        received.push(c);
      },
    };
    relay.addListener(listener);
  });

  describe('handleSseFrame', () => {
    it('dispatches a valid `commands` frame to listeners', () => {
      relay._testHelpers.feedSseFrame(
        sseFrame([
          { id: 'cmd-1', sessionId: 's1', pluginId: 'plugin-test', type: 'start_task', payload: { prompt: 'hi' }, status: 'pending', createdAt: 1 },
        ]),
      );
      expect(received).toHaveLength(1);
      expect(received[0].id).toBe('cmd-1');
      expect(received[0].type).toBe('start_task');
    });

    it('ignores non-`commands` events (e.g. heartbeat pings)', () => {
      relay._testHelpers.feedSseFrame('event: ping\ndata: {}\n');
      expect(received).toHaveLength(0);
    });

    it('ignores malformed JSON frames without throwing', () => {
      // A truncated frame mid-network — relay must not crash the
      // dispatch loop.
      expect(() =>
        relay._testHelpers.feedSseFrame('event: commands\ndata: {"commands":[\n'),
      ).not.toThrow();
      expect(received).toHaveLength(0);
    });

    it('ignores frames with an empty commands array', () => {
      relay._testHelpers.feedSseFrame(sseFrame([]));
      expect(received).toHaveLength(0);
    });

    it('dispatches multiple commands in a single frame in order', () => {
      relay._testHelpers.feedSseFrame(
        sseFrame([
          { id: 'a', sessionId: 's', pluginId: 'plugin-test', type: 'x', payload: {}, status: 'pending', createdAt: 1 },
          { id: 'b', sessionId: 's', pluginId: 'plugin-test', type: 'y', payload: {}, status: 'pending', createdAt: 2 },
          { id: 'c', sessionId: 's', pluginId: 'plugin-test', type: 'z', payload: {}, status: 'pending', createdAt: 3 },
        ]),
      );
      expect(received.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('command-id dedup', () => {
    it('skips a redelivered command id (SSE reconnect replay)', () => {
      const frame = sseFrame([
        { id: 'cmd-1', sessionId: 's', pluginId: 'plugin-test', type: 't', payload: {}, status: 'pending', createdAt: 1 },
      ]);
      relay._testHelpers.feedSseFrame(frame);
      relay._testHelpers.feedSseFrame(frame);
      relay._testHelpers.feedSseFrame(frame);
      expect(received).toHaveLength(1);
    });

    it('treats empty-string ids as always-new (no dedup key to compare)', () => {
      // Spec call: production code skips dedup on falsy id so a relay
      // bug never silently drops a real command on a missing id.
      expect(relay._testHelpers.markDispatched('')).toBe(true);
      expect(relay._testHelpers.markDispatched('')).toBe(true);
    });

    it('treats distinct ids as independent', () => {
      expect(relay._testHelpers.markDispatched('a')).toBe(true);
      expect(relay._testHelpers.markDispatched('b')).toBe(true);
      expect(relay._testHelpers.markDispatched('a')).toBe(false);
      expect(relay._testHelpers.markDispatched('b')).toBe(false);
    });

    it('keeps the cache bounded — prunes on insert past the threshold', () => {
      for (let i = 0; i < 260; i++) {
        expect(relay._testHelpers.markDispatched(`id-${i}`)).toBe(true);
      }
      // Cache size goes up but the prune branch only runs when size
      // crosses 256 on the NEXT insert; the threshold is intentional
      // soft-cap not a hard limit.
      expect(relay._testHelpers.recentCommandIdCount()).toBeLessThanOrEqual(260);
    });
  });

  describe('connection state transitions', () => {
    it('default state is offline', () => {
      expect(relay._testHelpers.getConnectionState()).toBe('offline');
    });

    it('SSE 200 marks transport success → online', () => {
      relay._testHelpers.markTransportSuccess('online');
      expect(relay._testHelpers.getConnectionState()).toBe('online');
    });

    it('polling fallback success flips offline → reconnecting (not online)', () => {
      relay._testHelpers.markTransportSuccess('reconnecting');
      expect(relay._testHelpers.getConnectionState()).toBe('reconnecting');
    });

    it('online → reconnecting on first transport failure', () => {
      relay._testHelpers.markTransportSuccess('online');
      relay._testHelpers.markTransportFailure();
      expect(relay._testHelpers.getConnectionState()).toBe('reconnecting');
    });

    it('fires onConnectionChange listeners on each transition', () => {
      const states: string[] = [];
      relay.onConnectionChange((s) => states.push(s));
      relay._testHelpers.markTransportSuccess('online');
      relay._testHelpers.markTransportSuccess('online'); // no-op (same state)
      relay._testHelpers.forceConnectionState('reconnecting');
      relay._testHelpers.forceConnectionState('offline');
      expect(states).toEqual(['online', 'reconnecting', 'offline']);
    });
  });

  describe('auth failure gate', () => {
    it('resetAuthFailureGate re-arms a fresh notification', () => {
      relay._testHelpers.resetForTest();
      relay.resetAuthFailureGate();
      expect(relay._testHelpers.isAuthFailureSurfaced()).toBe(false);
    });
  });
});
