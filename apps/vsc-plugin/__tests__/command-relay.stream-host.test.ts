import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

// Bead codeagent-8x0e.9: the extension opened /api/commands/pending/stream on
// `apiBaseUrl`. Once prod's api tier runs SERVICE_ROLE=api that route is a 404,
// so the extension would drop to polling forever. It must use the stream host.

interface FakeReq extends EventEmitter {
  end: () => void;
  destroy: () => void;
}
const requests: Array<{ hostname: string; path: string; respond: (status: number) => void; fail: () => void }> = [];

vi.mock('https', () => ({
  request: (opts: { hostname: string; path: string }, cb: (res: unknown) => void) => {
    const req = new EventEmitter() as FakeReq;
    req.end = () => undefined;
    req.destroy = () => undefined;
    requests.push({
      hostname: opts.hostname,
      path: opts.path,
      respond: (status: number) => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void; setEncoding: () => void };
        res.statusCode = status;
        res.resume = () => undefined;
        res.setEncoding = () => undefined;
        cb(res);
      },
      fail: () => req.emit('error', new Error('ECONNRESET')),
    });
    return req;
  },
}));

vi.mock('vscode', () => ({
  default: {},
  window: { showWarningMessage: vi.fn().mockResolvedValue(undefined) },
  commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../src/services/settings.service', () => ({
  SettingsService: {
    getInstance: () => ({
      apiBaseUrl: 'https://api.codeagent-mobile.com',
      ensurePluginId: () => 'plugin-test',
      heartbeatIntervalMs: 30_000,
      getPluginAuthToken: () => null,
      setPluginAuthToken: vi.fn(),
      ensurePollSecret: () => 'poll-secret-test',
      onApiBaseUrlChanged: vi.fn(),
    }),
  },
}));

vi.mock('../src/services/telemetry.service', () => ({ capture: vi.fn() }));

import { CommandRelayService, _testResetCommandRelay } from '../src/services/command-relay.service';

function makeLog(): vscode.OutputChannel {
  const stub: Pick<vscode.OutputChannel, 'appendLine' | 'name'> & Partial<vscode.OutputChannel> = {
    appendLine: vi.fn(),
    name: 'test',
  };
  return stub as vscode.OutputChannel;
}

describe('CommandRelayService — SSE stream host', () => {
  let relay: CommandRelayService;

  beforeEach(() => {
    requests.length = 0;
    _testResetCommandRelay();
    relay = CommandRelayService.initialize(makeLog());
  });

  it('opens the pending stream on stream.codeagent-mobile.com, not the api host', () => {
    relay._testHelpers.connectSSEForTest();
    expect(requests).toHaveLength(1);
    expect(requests[0].hostname).toBe('stream.codeagent-mobile.com');
    expect(requests[0].path).toMatch(/^\/api\/commands\/pending\/stream\?pluginId=plugin-test/);
  });

  it('falls back to the api host once on a 5xx before delivery, without spending the polling budget', () => {
    relay._testHelpers.connectSSEForTest();
    requests[0].respond(525);
    expect(requests).toHaveLength(2);
    expect(requests[1].hostname).toBe('api.codeagent-mobile.com');
    expect(relay._testHelpers.sseFailures()).toBe(0);
  });

  it('a 404 from the stream host is NOT masked by a host fallback', () => {
    relay._testHelpers.connectSSEForTest();
    requests[0].respond(404);
    expect(requests).toHaveLength(1);
    expect(relay._testHelpers.sseFailures()).toBe(1);
  });

  it('falls back on a network error before delivery', () => {
    relay._testHelpers.connectSSEForTest();
    requests[0].fail();
    expect(requests[requests.length - 1].hostname).toBe('api.codeagent-mobile.com');
  });
});
