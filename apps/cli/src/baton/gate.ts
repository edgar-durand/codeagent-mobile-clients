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

/** Feature kill-switch (default OFF). Truthy CODEAM_BATON enables the baton. */
export function batonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CODEAM_BATON;
  return !!v && v !== '0' && v.toLowerCase() !== 'false';
}
