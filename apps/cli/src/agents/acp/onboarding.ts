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

/** Just the slice of AcpClient we need — keeps this unit easy to test. */
interface PromptCapable {
  prompt(input: string): Promise<unknown>;
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
    'Write it for a phone screen — under ~110 words, friendly, easy to scan, a little',
    'energy. Cover briefly, in your own words:',
    '- Glad they spun up this session.',
    '- Through CodeAgent Mobile, agents like you get native context, persistent',
    '  memory, and an issue tracker — powered by Beads on Dolt — out of the box, zero setup.',
    '- They can drive you from their phone: live preview, rich visual output, a file viewer.',
    `- End with a SHORT, concrete invitation tied to THIS project (working dir: ${cwd},`,
    `  repo: "${repo}") — suggest 1–2 specific things you could help with here.`,
    '',
    'Rules: do NOT run any tools or shell commands — base the project hint only on the',
    'repo name/path above so your reply is instant. No preamble like "Sure" or "Of',
    'course" — start directly with the greeting. Use light markdown (one intro line +',
    'a few bullets). Keep it tight.',
  ].join('\n');
}

/**
 * Send the onboarding welcome once for a freshly paired session. Strictly
 * non-fatal + fire-and-forget: the agent's reply streams back through the
 * normal session/update → publishOutput path. A failure (or the kill-switch /
 * an already-welcomed marker) just means no welcome this run.
 */
export function maybeSendOnboardingWelcome(opts: {
  client: PromptCapable;
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
  // Fire-and-forget — the reply streams as the first agent message after the
  // welcome card; the instruction text is never published as a user message.
  void opts.client.prompt(buildOnboardingPrompt(opts.cwd)).catch((err: unknown) => {
    log.warn(
      'acpRunner',
      `onboarding welcome prompt failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}
