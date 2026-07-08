/** True only for a LOCAL session — NOT a codespace and NOT self-hosted.
 *  Mirrors the codebase idiom `CODESPACES==='true' || CODEAM_AUTO_APPROVE==='1'`
 *  (the autonomous/headless plane) and negates it, plus the daemon-token markers. */
export function isLocalSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.CODESPACES !== 'true' &&
    env.CODEAM_AUTO_APPROVE !== '1' &&
    env.HEADROOM_ENABLED !== '1' &&
    !env.CODEAM_AUTO_TOKEN &&
    !env.CODEAM_ENROLL_TOKEN
  );
}

/** Baton is ON by default for local sessions. `CODEAM_BATON=0` (or `false`)
 *  is the kill switch to opt back into the legacy headless-only local path. */
export function batonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CODEAM_BATON;
  if (v === undefined || v === '') return true;
  return v !== '0' && v.toLowerCase() !== 'false';
}
