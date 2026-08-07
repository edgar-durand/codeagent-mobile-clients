// src/integrations/mcp-tool-watchdog.ts
//
// A per-`tools/call` watchdog for an MCP relay. A wrapped/remote MCP server can
// accept a `tools/call` and NEVER send a response (a hung remote — e.g.
// mcp.vercel.com stalling on `list_deployments`, Rafael 2026-08-07 — or a stdio
// child that only answers while some external process is up). With no per-request
// timeout the agent's turn wedges FOREVER: no `done`, no error, nothing persisted,
// no Stop button. This watchdog bounds every `tools/call`: if the server doesn't
// answer within `timeoutMs`, it synthesizes a JSON-RPC error for that request id
// so the agent unblocks with a clean tool error, and then DROPS any late reply so
// the agent never sees two responses for one id.
//
// Pure + injectable (timers/clock) so it's unit-testable without real transports.
// `stdio-proxy.ts` has an equivalent inline watchdog for the spawned-child path;
// this helper covers the httpUrl relay path (which was never bounded).

interface JsonRpcMsg {
  method?: string;
  id?: string | number;
}

export interface ToolCallWatchdogDeps {
  timeoutMs: number;
  /** Integration id, used only for the human-readable timeout error message. */
  integrationId: string;
  /** Send a JSON-RPC message back to the AGENT (the stdio side of the relay). */
  sendToAgent: (msg: unknown) => void;
  /** Injectable for tests; defaults to global setTimeout (unref'd). */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (t: NodeJS.Timeout) => void;
}

export interface ToolCallWatchdog {
  /** Inspect an AGENT→server message; arm a timer for a `tools/call`. */
  onClientMessage: (msg: unknown) => void;
  /** Inspect a server→AGENT message; returns true if the caller must DROP it
   *  (a late reply to an id we already answered with a timeout error). */
  onServerMessage: (msg: unknown) => boolean;
  /** Clear all pending timers (call on relay teardown). */
  dispose: () => void;
}

export function createToolCallWatchdog(deps: ToolCallWatchdogDeps): ToolCallWatchdog {
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));

  const timers = new Map<string | number, NodeJS.Timeout>();
  const answered = new Set<string | number>();

  const clear = (id: string | number): void => {
    const t = timers.get(id);
    if (t) {
      clearTimer(t);
      timers.delete(id);
    }
  };

  return {
    onClientMessage(msg) {
      const m = msg as JsonRpcMsg;
      if (m.method !== 'tools/call' || m.id === undefined) return;
      const id = m.id;
      // Re-arm defensively if the same id is reused.
      clear(id);
      const timer = setTimer(() => {
        timers.delete(id);
        answered.add(id);
        deps.sendToAgent({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32001,
            message: `The ${deps.integrationId} tool did not respond within ${Math.round(
              deps.timeoutMs / 1000,
            )}s (remote MCP unresponsive). The request was aborted — try again or use a different tool.`,
          },
        });
      }, deps.timeoutMs);
      timers.set(id, timer);
    },
    onServerMessage(msg) {
      const m = msg as JsonRpcMsg;
      // A response is an id-bearing message with no `method`.
      if (m.id === undefined || m.method !== undefined) return false;
      clear(m.id);
      // We already synthesized a timeout error for this id → drop the late reply.
      return answered.delete(m.id);
    },
    dispose() {
      for (const t of timers.values()) clearTimer(t);
      timers.clear();
      answered.clear();
    },
  };
}
