/**
 * First-pair onboarding welcome.
 *
 * When a session is freshly paired, the agent proactively sends the user's
 * FIRST message — a short CodeAgent Mobile intro — right after the welcome
 * card, so the agent takes the initiative to invite the user to start.
 *
 * No new structure: this reuses the existing prompt→output flow. We send a
 * BACKGROUND prompt to the agent via `client.prompt()`; the instructions
 * themselves are never published as a user message (the CLI only publishes the
 * agent's streamed reply), so the app shows only the agent's onboarding text.
 *
 * Fires exactly once per paired session (a marker file under `~/.codeam`), so
 * reconnects / dormant-wakes don't re-welcome. Kill-switch:
 * `CODEAM_ONBOARDING_DISABLED`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../../services/logger';

/** Just the slices of the ACP runner we need — keeps this unit easy to test. */
interface PromptCapable {
  prompt(input: string): Promise<unknown>;
}

/**
 * The turn-streaming surface from `StreamingState`. We drive a real turn so
 * mobile gets the `clear` + `new_turn` boundary (typing indicator) and a final
 * `done:true`, and so we can snapshot the cumulative reply text to persist it.
 */
interface TurnStreaming {
  beginTurn(): Promise<void>;
  getCurrentText(): string;
  closeAll(): Promise<void>;
}

/**
 * The conversation-anchor surface from `AcpHistory`. Recording the reply here
 * is what makes it survive a SessionDetail opened AFTER the turn completed —
 * the chat hydrates from this anchor, not from SSE catchup (which drops
 * historical text). `appendAgentInitiatedReply` records the reply with NO user
 * bubble, so our background instruction is never shown.
 */
interface WelcomeHistory {
  appendAgentInitiatedReply(text: string): void;
  flush(): Promise<void>;
}

/**
 * Seam for the once-per-session marker + kill-switch, so tests drive the guard
 * without touching the real `~/.codeam` or `process.env`.
 */
export const _onboardingSeam = {
  markerPath: (sessionId: string): string =>
    path.join(os.homedir(), '.codeam', 'welcomed', `${sessionId}.done`),
  exists: (p: string): boolean => fs.existsSync(p),
  write: (p: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
  },
  disabled: (): boolean => {
    const v = process.env.CODEAM_ONBOARDING_DISABLED;
    return !!v && v !== '0' && v.toLowerCase() !== 'false';
  },
};

/**
 * The background instruction we hand the agent. NOT shown to the user — only
 * the agent's reply is. Written to produce a tight, skimmable, mobile-friendly
 * welcome with NO tool calls (so it returns instantly), tailored to the repo.
 */
export function buildOnboardingPrompt(cwd: string): string {
  const repo = path.basename(cwd || '') || 'this project';
  return [
    'SYSTEM / BACKGROUND TASK — this message is NOT from the user. The user just',
    'connected this session through CodeAgent Mobile and has only seen a welcome',
    'card. Take the initiative and write THEIR first message: a short, warm',
    'onboarding welcome that you (the agent) send proactively to invite them to start.',
    '',
    'Write it for a phone screen — aim ~160 words, friendly, easy to scan, a little',
    'energy. Cover briefly, in your own words (give the core features visibility):',
    '- Glad they spun up this session.',
    '- Through CodeAgent Mobile, agents like you get native repo context, persistent',
    '  memory, and an issue tracker — powered by Beads on Dolt — out of the box, zero setup.',
    '- They can drive you from their phone, with real core features:',
    '  • a full integrated IDE powered by Monaco — edit code, live preview, rich visual output (NOT just a file viewer);',
    '  • Smart Composer — helps them craft and structure prompts;',
    '  • Team Spaces — share this session with their team to collaborate, or hand a session to someone else.',
    '- Invite them to share feedback or report any issue via GitHub or the Discord',
    '  bugs channel. Include BOTH of these URLs in full, EXACTLY as written here',
    '  (keep the https:// scheme on each so the app renders them as tappable links):',
    '    https://github.com/edgar-durand/codeagent-mobile-clients/issues',
    '    https://discord.gg/ADMKwGAB',
    `- End with a SHORT, concrete invitation tied to THIS project (working dir: ${cwd},`,
    `  repo: "${repo}") — suggest 1–2 specific things you could help with here.`,
    '',
    'Rules: do NOT run any tools or shell commands — base the project hint only on the',
    'repo name/path above so your reply is instant. No preamble like "Sure" or "Of',
    'course" — start directly with the greeting. Use light markdown (one intro line +',
    'a few bullets). NEVER shorten a URL or drop its https:// scheme — paste each link',
    'verbatim so both render as navigable links. Keep it tight despite the feature list.',
  ].join('\n');
}

/**
 * Send the onboarding welcome once for a freshly paired session. Strictly
 * non-fatal + fire-and-forget: the turn streams back through the normal
 * session/update → publishOutput path AND is recorded into the conversation
 * anchor so it shows in chat even when SessionDetail is opened after the turn
 * finishes. A failure (or the kill-switch / an already-welcomed marker) just
 * means no welcome this run.
 */
export function maybeSendOnboardingWelcome(opts: {
  client: PromptCapable;
  streaming: TurnStreaming;
  history: WelcomeHistory;
  sessionId: string;
  cwd: string;
}): void {
  if (_onboardingSeam.disabled()) return;
  const marker = _onboardingSeam.markerPath(opts.sessionId);
  try {
    if (_onboardingSeam.exists(marker)) return; // already welcomed this session
    _onboardingSeam.write(marker);
  } catch (err) {
    // Can't read/write the marker — skip rather than risk re-welcoming on a
    // loop. (A transient FS error is rarer + less annoying than a double send.)
    log.trace('acpRunner', `onboarding marker check failed: ${(err as Error).message}`);
    return;
  }
  log.info('acpRunner', `sending first-pair onboarding welcome for session=${opts.sessionId.slice(0, 8)}`);
  // Fire-and-forget — must not block session startup. The turn runs + records
  // the reply asynchronously; the instruction text is never a user message.
  void runOnboardingTurn(opts).catch((err: unknown) => {
    log.warn(
      'acpRunner',
      `onboarding welcome turn failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

/**
 * Run the onboarding prompt as a real turn and persist the reply.
 *
 * Mirrors the runner's normal turn shape — `beginTurn()` (clear + new_turn →
 * "Agent is typing…"), `client.prompt()`, snapshot `getCurrentText()`,
 * `closeAll()` (one `done:true`; no select_prompt extraction — the welcome is
 * conversational, not a menu) — then records the reply into the conversation
 * anchor WITHOUT a user prompt. The anchor is what mobile's chat hydrates from
 * on open, so this is what makes the welcome appear when the user navigates in
 * after the turn already completed.
 */
async function runOnboardingTurn(opts: {
  client: PromptCapable;
  streaming: TurnStreaming;
  history: WelcomeHistory;
  cwd: string;
}): Promise<void> {
  const { client, streaming, history, cwd } = opts;
  await streaming.beginTurn();
  try {
    await client.prompt(buildOnboardingPrompt(cwd));
    const reply = streaming.getCurrentText();
    await streaming.closeAll();
    history.appendAgentInitiatedReply(reply);
    await history.flush();
  } catch (err) {
    // Best-effort finalize so the chat doesn't sit on "Agent is typing…".
    await streaming.closeAll().catch(() => undefined);
    throw err;
  }
}
