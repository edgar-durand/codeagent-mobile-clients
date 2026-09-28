/**
 * The app's "Stop session" / "Delete session" (`shutdown_session` /
 * `session_terminated`) ends the ACP process. Before `process.exit` it must
 * await the preview + scratch-export tunnel reap — an orphaned export
 * cloudflared keeps a connector on the box's named tunnel and breaks the next
 * preview. Driven through the exported `ACP_COMMAND_HANDLERS` map.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/commands/start/shutdown-tunnels', () => ({
  reapPreviewsAndExportTunnel: vi.fn(),
}));
vi.mock('../../../src/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/config')>()),
  removeSession: vi.fn(),
}));
vi.mock('../../../src/services/terminal-ops.service', () => ({
  registerTerminalHandlers: vi.fn(),
  closeAllTerminals: vi.fn(),
}));
vi.mock('../../../src/services/command-relay.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/command-relay.service')>()),
  stopRelayWithGoodbye: vi.fn(async () => undefined),
}));
vi.mock('../../../src/ui/banner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ui/banner')>()),
  showInfo: vi.fn(),
}));

import { ACP_COMMAND_HANDLERS, type AcpCommandContext } from '../../../src/agents/acp/command-handlers';
import { reapPreviewsAndExportTunnel } from '../../../src/commands/start/shutdown-tunnels';

let order: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    order.push(`exit:${code}`);
  }) as never);
  vi.mocked(reapPreviewsAndExportTunnel).mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 5));
    order.push('reaped');
  });
});

afterEach(() => {
  exitSpy.mockRestore();
});

function ctxFor(type: string): AcpCommandContext {
  return {
    cmd: { id: 'c1', sessionId: 's1', type, payload: {} },
    relay: { sendResult: vi.fn(async () => undefined) },
    client: { stop: vi.fn(async () => undefined) },
    opts: { sessionId: 's1' },
  } as unknown as AcpCommandContext;
}

describe('sessionShutdownH (ACP) reaps previews + export tunnel before exiting', () => {
  it.each(['shutdown_session', 'session_terminated'])('%s awaits the reap BEFORE process.exit', async (type) => {
    await ACP_COMMAND_HANDLERS[type](ctxFor(type));
    expect(reapPreviewsAndExportTunnel).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['reaped', 'exit:0']);
  });
});
