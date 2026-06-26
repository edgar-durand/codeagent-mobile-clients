/**
 * Unit tests for PairingService.requestPairingCode — blocked-branch decisions.
 *
 * Covers:
 *   1. Preflight 'blocked' → returns { blocked: true } without hitting /api/pairing/code.
 *   2. Transport error from relay.postJson → returns { blocked: true }.
 *   3. Reachable preflight + successful backend → returns { code, expiresAt }.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import type * as vscode from 'vscode';

vi.mock('vscode', () => ({
  default: {},
  version: '1.90.0',
}));

// ---- shared service fakes -------------------------------------------------

const settings = {
  apiBaseUrl: 'http://127.0.0.1:0', // overridden per test
  ensurePluginId: vi.fn(() => 'plugin-test-rpc'),
  ensurePollSecret: vi.fn(() => 'poll-secret-rpc'),
  setPluginAuthToken: vi.fn(),
  addRecentSession: vi.fn(),
};

vi.mock('../src/services/settings.service', () => ({
  SettingsService: { getInstance: () => settings },
}));

// postJson is used by requestPairingCode for the /api/pairing/code call.
// We swap out the relay factory per test so we can simulate transport errors.
let postJsonImpl: (url: string, body: Record<string, unknown>) => Promise<Record<string, unknown> | null> =
  async () => null;

vi.mock('../src/services/command-relay.service', () => ({
  CommandRelayService: {
    getInstance: () => ({
      postJson: (url: string, body: Record<string, unknown>) => postJsonImpl(url, body),
      resetAuthFailureGate: vi.fn(),
    }),
  },
}));

// checkApiReachable is the preflight gate — swapped per test.
let checkApiReachableImpl: (url: string) => Promise<'reachable' | 'blocked'> =
  async () => 'reachable';

vi.mock('../src/services/connectivity', () => ({
  checkApiReachable: (url: string) => checkApiReachableImpl(url),
}));

// project-ops is dynamically imported inside requestPairingCode — stub it.
vi.mock('../src/services/project-ops.service', () => ({
  ProjectOpsService: {
    detectCurrentBranch: vi.fn(async () => null),
  },
}));

// ---- helpers ---------------------------------------------------------------

import { PairingService } from '../src/services/pairing.service';

function makeLog(): vscode.OutputChannel {
  return {
    appendLine: vi.fn(),
    append: vi.fn(),
    name: 'test-rpc',
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    clear: vi.fn(),
    replace: vi.fn(),
  } as unknown as vscode.OutputChannel;
}

// ---- tests -----------------------------------------------------------------

describe('PairingService.requestPairingCode — blocked-branch decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to safe defaults
    checkApiReachableImpl = async () => 'reachable';
    postJsonImpl = async () => null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns { blocked: true } immediately when preflight reports blocked (no backend call)', async () => {
    checkApiReachableImpl = async () => 'blocked';
    // Track whether postJson was called
    let postJsonCalled = false;
    postJsonImpl = async () => { postJsonCalled = true; return null; };

    const pairing = PairingService.initialize(makeLog());
    const result = await pairing.requestPairingCode();

    expect(result).toEqual({ blocked: true });
    expect(postJsonCalled).toBe(false);
  });

  it('returns { blocked: true } when relay.postJson throws (transport error)', async () => {
    checkApiReachableImpl = async () => 'reachable';
    postJsonImpl = async () => { throw new Error('ECONNREFUSED'); };

    const pairing = PairingService.initialize(makeLog());
    const result = await pairing.requestPairingCode();

    expect(result).toEqual({ blocked: true });
  });

  it('returns { code, expiresAt } on the happy path (preflight reachable, backend succeeds)', async () => {
    // Spin up a real local HTTP server so postJson sees a real response.
    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { code: 'ABC123', expiresAt: 9999999999 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    settings.apiBaseUrl = `http://127.0.0.1:${address.port}`;

    checkApiReachableImpl = async () => 'reachable';
    // Let the real CommandRelayService.postJson run (it's mocked to delegate)
    postJsonImpl = async (_url, _body) => {
      // Mirror what relay.postJson actually does: an HTTP POST that resolves
      // with the parsed body. We re-use the server above via a raw fetch.
      const resp = await fetch(`http://127.0.0.1:${address.port}/api/pairing/code`, {
        method: 'POST',
        body: JSON.stringify(_body),
        headers: { 'Content-Type': 'application/json' },
      });
      return resp.json() as Promise<Record<string, unknown>>;
    };

    const pairing = PairingService.initialize(makeLog());
    const result = await pairing.requestPairingCode();

    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(result).toEqual({ code: 'ABC123', expiresAt: 9999999999 });
  });

  it('returns null when preflight passes but backend returns no data', async () => {
    checkApiReachableImpl = async () => 'reachable';
    postJsonImpl = async () => ({ success: false }); // no .data

    const pairing = PairingService.initialize(makeLog());
    const result = await pairing.requestPairingCode();

    expect(result).toBeNull();
  });
});
