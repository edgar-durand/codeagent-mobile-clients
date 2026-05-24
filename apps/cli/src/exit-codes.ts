/**
 * Sentinel exit codes for the CLI.
 *
 * Convention is the standard POSIX one (0 ok, 1 failure) plus
 * specific codes for outcomes a caller (CI, scripts) might want
 * to branch on:
 *
 *   0   — success
 *   1   — runtime failure (network, agent crash, generic catch-all)
 *   2   — usage error (unknown command, bad flag, missing required arg)
 *   3   — needs pairing (caller can prompt the user to run `codeam pair`)
 *   130 — interrupted by Ctrl+C (SIGINT — 128 + signal=2)
 *   143 — terminated by SIGTERM (128 + signal=15)
 *
 * The 128+signal codes are documented because some downstream
 * wrappers (CI runners, supervisor scripts) treat them as "user
 * cancelled" vs "real failure" and we want that mapping stable.
 */

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_NEEDS_PAIRING = 3;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

/** Stable map of exit-code → name for diagnostic logging. */
export const EXIT_CODE_NAMES: Record<number, string> = {
  [EXIT_OK]: 'ok',
  [EXIT_FAILURE]: 'failure',
  [EXIT_USAGE]: 'usage_error',
  [EXIT_NEEDS_PAIRING]: 'needs_pairing',
  [EXIT_SIGINT]: 'sigint',
  [EXIT_SIGTERM]: 'sigterm',
};
