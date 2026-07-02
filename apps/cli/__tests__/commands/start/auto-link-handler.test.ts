/**
 * Tests for the `request_link_credentials` relay handler — the
 * backend-initiated auto-link that vaults a running agent's local
 * credentials.
 *
 * Regression (2026-07-02 incident): the handler's postLinkCredential
 * call omitted `preserveSession: true`, so the backend's linkFromCli
 * treated the link as a `codeam link <agent>` throwaway and DELETED
 * the user's real paired session 8 seconds after pairing (web
 * dashboard went CONVERSATION_AUTH_REQUIRED, session card vanished).
 * The backend now also guards this via its own Redis flag, but the
 * CLI must state the truth: an auto-link always rides a REAL session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../../../src/commands/start/handlers';
import type { RemoteCommand } from '../../../src/services/command-relay.service';
import type { CommandRelayService } from '../../../src/services/command-relay.service';

vi.mock('../../../src/services/pairing.service', () => ({
  postLinkCredential: vi.fn().mockResolvedValue({ ok: true }),
  postCliUpdateEvent: vi.fn(),
  postAiResult: vi.fn(),
  postPreviewEvent: vi.fn(),
  postHeadroomEvent: vi.fn(),
  postBeadsEvent: vi.fn(),
  _transport: { postJson: vi.fn(), getJson: vi.fn(), postJsonAuthed: vi.fn() },
}));

vi.mock('../../../src/commands/link', () => ({
  buildLinkContext: vi.fn(() => ({
    displayName: 'Claude Code',
    locator: {
      publicId: 'claude_code',
      extract: vi.fn().mockResolvedValue({
        method: 'oauth_token',
        credential: '{"claudeAiOauth":{}}',
        source: 'credentials-file',
      }),
    },
  })),
}));

import { handlers } from '../../../src/commands/start/handlers';
import { postLinkCredential } from '../../../src/services/pairing.service';

const postLinkCredentialMock = vi.mocked(postLinkCredential);

function makeCtx(overrides?: Partial<HandlerContext>): HandlerContext {
  const relay = { sendResult: vi.fn().mockResolvedValue(undefined) } as unknown as CommandRelayService;
  return {
    outputSvc: {} as HandlerContext['outputSvc'],
    agent: {} as HandlerContext['agent'],
    historySvc: {} as HandlerContext['historySvc'],
    relay,
    runtime: {} as HandlerContext['runtime'],
    setKeepAlive: vi.fn(),
    keepAliveCtx: { inCodespace: false } as HandlerContext['keepAliveCtx'],
    pluginId: 'plug-1',
    sessionId: 'sess-1',
    agentId: 'claude',
    pluginAuthToken: 'tok-1',
    ...overrides,
  };
}

const cmd: RemoteCommand = {
  id: 'cmd-1',
  sessionId: 'sess-1',
  type: 'request_link_credentials',
  payload: {},
};

async function flushBackgroundWork(): Promise<void> {
  // The handler is fire-and-forget (void IIFE) — drain the microtask
  // queue so the mocked extract + post settle before asserting.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('request_link_credentials — auto-link rides the REAL paired session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postLinkCredentialMock.mockResolvedValue({ ok: true });
  });

  it('sends preserveSession: true so the backend never deletes the just-paired session', async () => {
    await handlers.request_link_credentials(makeCtx(), cmd, { agentId: 'claude_code' });
    await flushBackgroundWork();

    expect(postLinkCredentialMock).toHaveBeenCalledTimes(1);
    expect(postLinkCredentialMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude_code',
        sessionId: 'sess-1',
        preserveSession: true,
      }),
    );
  });

  it('no-ops without a pluginAuthToken (never posts)', async () => {
    await handlers.request_link_credentials(
      makeCtx({ pluginAuthToken: undefined }),
      cmd,
      { agentId: 'claude_code' },
    );
    await flushBackgroundWork();
    expect(postLinkCredentialMock).not.toHaveBeenCalled();
  });
});
