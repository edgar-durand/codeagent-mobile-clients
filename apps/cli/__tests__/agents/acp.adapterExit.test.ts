/**
 * adapterExitMessage — how an ACP adapter's OUT-OF-BAND death is classified
 * into a user-facing bubble (or suppressed).
 *
 * The bug (2026-07-04): a Windows CLI user (platform=win32) closed their
 * terminal, which kills the agent adapter with NTSTATUS 0xC000013A
 * (STATUS_CONTROL_C_EXIT = 3221225786). The runner classified that as
 * "Agent adapter exited unexpectedly (code=3221225786 signal=null)" — a
 * cryptic fake crash shown to the user AND recorded as a failed session in
 * the daily email digest. A Ctrl+C / console-close is the user ENDING the
 * session, not a crash: it must be suppressed (null → no bubble, clean exit).
 * Real auth/outage/crash exits keep their actionable messages.
 */
import { describe, expect, it } from 'vitest';
import {
  adapterExitMessage,
  WINDOWS_CONTROL_C_EXIT,
  AUTH_FAILURE_MESSAGE,
  providerOutageMessage,
} from '../../src/agents/acp/runner';

const base = { authFail: false, outageFail: false, agent: 'claude' };

describe('adapterExitMessage', () => {
  it('suppresses the Windows Ctrl+C / console-close exit (0xC000013A)', () => {
    expect(WINDOWS_CONTROL_C_EXIT).toBe(3221225786);
    expect(
      adapterExitMessage({ ...base, code: WINDOWS_CONTROL_C_EXIT, signal: null }),
    ).toBeNull();
  });

  it('suppresses a POSIX SIGINT (Ctrl+C) shutdown', () => {
    expect(adapterExitMessage({ ...base, code: null, signal: 'SIGINT' })).toBeNull();
  });

  it('still reports a genuine unexpected crash with the code + signal', () => {
    const msg = adapterExitMessage({ ...base, code: 1, signal: null });
    expect(msg).toContain('exited unexpectedly');
    expect(msg).toContain('code=1');
  });

  it('reports a SIGKILL (e.g. OOM) as a real crash, not a benign shutdown', () => {
    const msg = adapterExitMessage({ ...base, code: null, signal: 'SIGKILL' });
    expect(msg).toContain('exited unexpectedly');
    expect(msg).toContain('SIGKILL');
  });

  it('prefers the auth-failure message when the adapter died on an auth error', () => {
    expect(
      adapterExitMessage({ ...base, code: 1, signal: null, authFail: true }),
    ).toBe(AUTH_FAILURE_MESSAGE);
  });

  it('prefers the provider-outage message on an upstream outage', () => {
    expect(
      adapterExitMessage({ ...base, code: 1, signal: null, outageFail: true }),
    ).toBe(providerOutageMessage('claude'));
  });

  it('a benign Ctrl+C wins even if an auth error was also flagged (user ended it)', () => {
    // The user closing the terminal is unambiguous intent — don't nag them
    // with a re-auth bubble they didn't ask for.
    expect(
      adapterExitMessage({
        ...base,
        code: WINDOWS_CONTROL_C_EXIT,
        signal: null,
        authFail: true,
      }),
    ).toBeNull();
  });
});
