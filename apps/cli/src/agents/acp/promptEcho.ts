/**
 * Format the one-line breadcrumb the CLI prints to stdout whenever a
 * mobile-originated `start_task` lands. QA Android #287: pre-ACP the
 * legacy PTY path injected the prompt directly into claude's stdin so
 * the terminal naturally echoed it; under ACP the prompt rides the
 * adapter's JSON-RPC and never touches the terminal. The breadcrumb
 * restores the "something just happened locally" signal for whoever
 * is watching the laptop terminal.
 *
 * Pure / synchronous — wired into the runner via a single
 * `console.log(formatPromptEchoLine(payload))` call right before the
 * prompt is forwarded to the adapter. Empty-string return short-
 * circuits the log so we never spam blank lines.
 */
const MAX_PROMPT_CHARS = 200;

/** Cap for the echoed agent reply line in `codeam pair`. */
const MAX_AGENT_REPLY_CHARS = 280;

export interface PromptEchoPayload {
  prompt?: string;
  files?: Array<{ filename: string; base64?: string; mimeType?: string }>;
}

export function formatPromptEchoLine(payload: PromptEchoPayload): string {
  const rawText = (payload.prompt ?? '').replace(/\s+/g, ' ').trim();
  const imageCount = (payload.files ?? []).filter(
    (f) => typeof f.base64 === 'string' && f.base64.length > 0,
  ).length;

  if (rawText.length === 0 && imageCount === 0) return '';

  const truncatedText =
    rawText.length > MAX_PROMPT_CHARS
      ? rawText.slice(0, MAX_PROMPT_CHARS) + '…'
      : rawText;

  const parts: string[] = [];
  if (truncatedText.length > 0) {
    parts.push(`Mobile: ${truncatedText}`);
  }
  if (imageCount > 0) {
    parts.push(`+ ${imageCount} image${imageCount === 1 ? '' : 's'}`);
  }
  return `› ${parts.join(' ')}`;
}

/**
 * Format the agent's reply for the `codeam pair` terminal — the
 * OUTBOUND counterpart to {@link formatPromptEchoLine}. Gives the
 * operator the full thread (inbound `› Mobile: …` + outbound
 * `‹ Agent: …`) and surfaces, at a glance, whether the agent actually
 * produced a reply for the turn. Returns '' for an empty reply so the
 * caller prints nothing.
 */
export function formatAgentReplyLine(text: string): string {
  const collapsed = (text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '';
  const truncated =
    collapsed.length > MAX_AGENT_REPLY_CHARS
      ? collapsed.slice(0, MAX_AGENT_REPLY_CHARS) + '…'
      : collapsed;
  return `‹ Agent: ${truncated}`;
}
