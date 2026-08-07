/**
 * Root-cause regression (Rafael, 2026-08-07): a remote MCP over Streamable HTTP
 * (`mcp.vercel.com`) accepted a `tools/call` and NEVER responded, so the byte-
 * level http relay — which had NO per-request timeout — left the agent's turn
 * wedged forever (no `done`, no error, nothing persisted, no Stop button). This
 * watchdog bounds every `tools/call`. Tests use an injected clock so the timeout
 * is deterministic, and are mutation-resistant (removing the arm / the drop of a
 * late reply fails a case).
 */
import { describe, it, expect, vi } from 'vitest';
import { createToolCallWatchdog } from '../../src/integrations/mcp-tool-watchdog';

function harness(timeoutMs = 120_000) {
  const sent: unknown[] = [];
  let fire: (() => void) | null = null;
  const wd = createToolCallWatchdog({
    timeoutMs,
    integrationId: 'vercel',
    sendToAgent: (m) => sent.push(m),
    // Capture the timer callback so the test controls when it "fires".
    setTimer: (fn) => {
      fire = fn;
      // A truthy handle — matches Node's setTimeout (returns a Timeout object),
      // so the watchdog's `if (timer)` clear-guard behaves as in production.
      return { __fake: true } as unknown as NodeJS.Timeout;
    },
    clearTimer: () => {
      fire = null;
    },
  });
  return { wd, sent, fireTimeout: () => fire?.() };
}

const toolsCall = (id: number | string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: {} });
const response = (id: number | string) => ({ jsonrpc: '2.0', id, result: { ok: true } });

describe('mcp-tool-watchdog', () => {
  it('synthesizes a JSON-RPC error to the agent when a tools/call never gets a response', () => {
    const { wd, sent, fireTimeout } = harness();
    wd.onClientMessage(toolsCall(7));
    expect(sent).toHaveLength(0); // still waiting
    fireTimeout(); // remote never answered → timeout fires
    expect(sent).toHaveLength(1);
    const err = sent[0] as { id: number; error?: { code: number; message: string } };
    expect(err.id).toBe(7);
    expect(err.error?.code).toBe(-32001);
    expect(err.error?.message).toMatch(/vercel/);
  });

  it('does NOT synthesize an error when the response arrives before the timeout', () => {
    const { wd, sent, fireTimeout } = harness();
    wd.onClientMessage(toolsCall(7));
    const drop = wd.onServerMessage(response(7)); // remote answered in time
    expect(drop).toBe(false); // forward it normally
    fireTimeout(); // timer was cleared → no-op
    expect(sent).toHaveLength(0);
  });

  it('DROPS a late remote reply for an id it already timed out (no double-response)', () => {
    const { wd, fireTimeout } = harness();
    wd.onClientMessage(toolsCall(7));
    fireTimeout(); // synthesized the error
    const drop = wd.onServerMessage(response(7)); // remote replies late
    expect(drop).toBe(true); // caller must drop it
    // A subsequent unrelated response is NOT dropped.
    expect(wd.onServerMessage(response(8))).toBe(false);
  });

  it('only arms for tools/call — never for handshake calls or notifications', () => {
    const { wd, sent, fireTimeout } = harness();
    wd.onClientMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    wd.onClientMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
    fireTimeout(); // whatever the last arm was — there should be none
    expect(sent).toHaveLength(0);
  });

  it('dispose clears pending timers', () => {
    const clearTimer = vi.fn();
    const wd = createToolCallWatchdog({
      timeoutMs: 1000,
      integrationId: 'vercel',
      sendToAgent: () => undefined,
      setTimer: () => 42 as unknown as NodeJS.Timeout,
      clearTimer,
    });
    wd.onClientMessage(toolsCall(7));
    wd.dispose();
    expect(clearTimer).toHaveBeenCalledWith(42);
  });
});
