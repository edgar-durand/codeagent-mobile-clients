import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import type * as vscode from 'vscode';

vi.mock('vscode', () => ({
  default: {},
}));

const settings = {
  apiBaseUrl: '',
  ensurePluginId: vi.fn(() => 'plugin-test'),
  ensurePollSecret: vi.fn(() => 'poll-secret-test'),
  setPluginAuthToken: vi.fn(),
  addRecentSession: vi.fn(),
};

const resetAuthFailureGate = vi.fn();
const startPolling = vi.fn();

vi.mock('../src/services/settings.service', () => ({
  SettingsService: {
    getInstance: () => settings,
  },
}));

vi.mock('../src/services/command-relay.service', () => ({
  CommandRelayService: {
    getInstance: () => ({ resetAuthFailureGate, startPolling }),
  },
}));

import { PairingService } from '../src/services/pairing.service';
import { CommandRelayService } from '../src/services/command-relay.service';

function makeLog(): vscode.OutputChannel {
  return {
    appendLine: vi.fn(),
    append: vi.fn(),
    name: 'test',
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    clear: vi.fn(),
    replace: vi.fn(),
  } as unknown as vscode.OutputChannel;
}

describe('PairingService.reconnectSession', () => {
  let server: http.Server | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  });

  it('stores the fresh reconnect token before marking the session paired', async () => {
    const requests: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        requests.push({ headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          success: true,
          data: {
            pluginAuthToken: 'fresh-token',
            user: {
              name: 'Nabeel',
              email: 'nabeel@example.com',
              plan: 'PRO',
              currentPeriodEnd: '2026-07-01T00:00:00.000Z',
            },
          },
        }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP server');
    settings.apiBaseUrl = `http://127.0.0.1:${address.port}`;

    const pairing = PairingService.initialize(makeLog());
    const onPaired = vi.fn();
    pairing.addListener({ onPaired });

    const ok = await pairing.reconnectSession('sess-1', {
      sessionId: 'sess-1',
      userName: 'Cached',
      userEmail: 'cached@example.com',
      userPlan: 'FREE',
    });

    expect(ok).toBe(true);
    expect(JSON.parse(requests[0].body)).toEqual({
      pluginId: 'plugin-test',
      sessionId: 'sess-1',
    });
    expect(requests[0].headers['x-plugin-poll-secret']).toBe('poll-secret-test');
    expect(requests[0].headers['x-plugin-auth-token']).toBeUndefined();
    expect(settings.setPluginAuthToken).toHaveBeenCalledWith('fresh-token');
    expect(resetAuthFailureGate).toHaveBeenCalledTimes(1);
    expect(onPaired).toHaveBeenCalledWith('sess-1');
    expect(pairing.currentSessionId).toBe('sess-1');
    expect(pairing.pairedUser).toMatchObject({
      name: 'Nabeel',
      email: 'nabeel@example.com',
      plan: 'PRO',
    });
    expect(settings.addRecentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        userName: 'Nabeel',
        userEmail: 'nabeel@example.com',
        userPlan: 'PRO',
      }),
    );
  });

  it('returns false without changing local pairing state when reconnect is rejected', async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP server');
    settings.apiBaseUrl = `http://127.0.0.1:${address.port}`;

    const pairing = PairingService.initialize(makeLog());

    await expect(pairing.reconnectSession('missing-session')).resolves.toBe(false);
    expect(settings.setPluginAuthToken).not.toHaveBeenCalled();
    expect(pairing.currentSessionId).toBeNull();
  });

  it('brings the command relay ONLINE through the onPaired wiring after reconnect', async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: true,
        data: {
          pluginAuthToken: 'fresh-token',
          user: { name: 'Nabeel', email: 'nabeel@example.com', plan: 'PRO' },
        },
      }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP server');
    settings.apiBaseUrl = `http://127.0.0.1:${address.port}`;

    const pairing = PairingService.initialize(makeLog());
    // Mirror the panel/extension wiring: the onPaired listener is what
    // actually flips the relay ONLINE. This closes the loop from
    // "token refreshed" to "mobile sees the CLI online".
    pairing.addListener({
      onPaired: () => {
        CommandRelayService.getInstance().startPolling();
      },
    });

    const ok = await pairing.reconnectSession('sess-1');

    expect(ok).toBe(true);
    expect(startPolling).toHaveBeenCalledTimes(1);
  });
});
