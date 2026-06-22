/**
 * Regression for the recurring "chat detail stuck mid-reply, but the preview /
 * durable conversation HAS the full response" bug on ACP codespaces.
 *
 * ROOT CAUSE: `get_conversation` for ACP agents acked the conversation id but
 * NEVER uploaded the on-disk `<acpSessionId>.jsonl` transcript. So when the live
 * streaming-chunk render truncated mid-turn, the backend had no canonical
 * conversation to serve and the app could not heal — the chat froze on the
 * partial reply forever (e.g. a lone opening "```").
 *
 * The fix routes `get_conversation` through {@link handleGetConversation}, which
 * uploads the transcript (via the legacy HistoryService) BEFORE acking, so the
 * app can fetch the full history and replace the truncated turn.
 *
 * These assertions FAIL against the pre-fix handler (which never called
 * loadConversation) and PASS after — verified by reverting the loadConversation
 * call → "uploads the transcript" fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleGetConversation } from '../../../src/agents/acp/runner';

describe('handleGetConversation — ACP transcript upload contract', () => {
  it('uploads the on-disk transcript for the ACP session id BEFORE acking', async () => {
    const uploadConversationIfChanged = vi.fn().mockResolvedValue(true);
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await handleGetConversation({
      relay: { sendResult },
      commandId: 'cmd-1',
      jsonlHistory: { uploadConversationIfChanged },
      acpSessionId: '54de464c',
    });

    // The regression: pre-fix this never happened — the canonical transcript
    // was never uploaded, so a truncated live turn had nothing to heal from.
    expect(uploadConversationIfChanged).toHaveBeenCalledWith('54de464c');
    expect(sendResult).toHaveBeenCalledWith('cmd-1', 'completed', {
      conversationId: '54de464c',
    });
    // Upload must precede the ack so the canonical conversation is in place by
    // the time the app fetches it in response to the ack.
    expect(uploadConversationIfChanged.mock.invocationCallOrder[0]).toBeLessThan(
      sendResult.mock.invocationCallOrder[0],
    );
  });

  it('still acks the conversation id when the upload fails (best-effort, never blocks the command)', async () => {
    const uploadConversationIfChanged = vi.fn().mockRejectedValue(new Error("no JSONL on disk / network down"));
    const sendResult = vi.fn().mockResolvedValue(undefined);

    await expect(
      handleGetConversation({
        relay: { sendResult },
        commandId: 'cmd-2',
        jsonlHistory: { uploadConversationIfChanged },
        acpSessionId: 'abc12345',
      }),
    ).resolves.toBeUndefined();

    expect(uploadConversationIfChanged).toHaveBeenCalledWith('abc12345');
    expect(sendResult).toHaveBeenCalledWith('cmd-2', 'completed', {
      conversationId: 'abc12345',
    });
  });
});
