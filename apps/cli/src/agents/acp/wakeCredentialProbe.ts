/**
 * Proactive credential validation on session start / codespace wake.
 *
 * When a dormant codespace wakes, its agent's OAuth token may have expired
 * while it slept. Previously the user only learned this by SENDING a message
 * and getting a failed turn (observed 2026-07-05: two wasted turns before the
 * 401 surfaced). This probe checks the LOCAL credential expiry — network-free —
 * at the readiness seam and, if it's unrecoverably expired, surfaces the
 * re-auth bubble in chat immediately (before the user spends a turn) and flags
 * the LinkedAgent so Profile › Agents reflects it.
 *
 * Kept out of the heavy runner graph (no import back into runner.ts) and shaped
 * as a DI factory so it unit-tests with fakes — same pattern as
 * `createOneMRecovery`. The runner wires the injected callbacks to the live
 * publisher / history / reportCredentialInvalid.
 */
import { extractLocalClaudeToken } from '../claude/local-token';
import { validateClaudeToken } from '../claude/link';

export type CredentialExpiryStatus = 'valid' | 'expired' | 'unknown';

/**
 * Network-free local expiry status for an agent's credential. Reuses the exact
 * validators the link flow uses. Only `expired` (access token past AND no
 * refresh token — genuinely unrecoverable) is actionable; everything else
 * (valid, API key, refreshable, unparseable, non-Claude) is `unknown` so we
 * NEVER false-trigger a re-auth on a working credential.
 *
 * Claude only for now — it's the observed incident and the vast majority of
 * codespace agents. Other agents return `unknown` (a safe no-op); wiring their
 * peer validators (codex/gemini local-token) is an additive follow-up.
 */
export async function localCredentialExpiryStatus(
  agent: string,
): Promise<CredentialExpiryStatus> {
  if (!/claude/i.test(agent)) return 'unknown';
  const token = await extractLocalClaudeToken();
  if (!token) return 'unknown';
  return validateClaudeToken(token).status;
}

export interface WakeCredentialProbeDeps {
  /** Network-free expiry status for the session's agent. */
  getStatus: () => CredentialExpiryStatus | Promise<CredentialExpiryStatus>;
  /** Publish the standalone re-auth bubble into the chat (new_turn + text/done
   *  + persist to history). */
  emitReauthBubble: () => Promise<void>;
  /** Flag the LinkedAgent invalid on the backend (Profile › Agents reflects it). */
  reportCredentialInvalid: () => Promise<void> | void;
  log?: (msg: string) => void;
}

export interface WakeCredentialProbe {
  /** Returns true iff it detected an expired credential and surfaced re-auth. */
  run: () => Promise<boolean>;
}

export function createWakeCredentialProbe(deps: WakeCredentialProbeDeps): WakeCredentialProbe {
  return {
    run: async () => {
      let status: CredentialExpiryStatus;
      try {
        status = await deps.getStatus();
      } catch {
        // A probe that can't read the credential must never block the session.
        return false;
      }
      if (status !== 'expired') return false;
      deps.log?.('wake credential probe — local token expired, surfacing re-auth');
      try {
        await deps.emitReauthBubble();
      } catch {
        /* best-effort — never throw out of the boot path */
      }
      try {
        await deps.reportCredentialInvalid();
      } catch {
        /* best-effort */
      }
      return true;
    },
  };
}
