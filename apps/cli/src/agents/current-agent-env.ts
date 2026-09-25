/**
 * The env overlay of the agent that is driving the session RIGHT NOW.
 *
 * ⚠️ Why this exists (break-it emulator session 2026-09-24): the ACP adapter is
 * (re)spawned with `{ ...process.env, ...extraEnv }`, and an in-session switch
 * rewrites `extraEnv` (e.g. BYO OpenRouter → CodeAgent managed Qwen). But the
 * headless one-shots — Preview detection, AI summaries, insights — spawned
 * with the bare `process.env`, which is frozen at DEPLOY time. So after a
 * switch the chat answered through our proxy while Preview detection still
 * called the deploy-time agent (a $0 OpenRouter key): `API Error: 402 … can
 * only afford 1770` → "Detection Failed · ERR_MANIFEST_INVALID". One-shots must
 * run as the CURRENT agent, never the one the session was created with.
 *
 * `undefined` values mean "unset this key" (see clearHouseProxyEnvOverrides).
 */
let overlay: Record<string, string | undefined> = {};

/** Record the env the current agent was (re)spawned with. */
export function setCurrentAgentEnv(next: Record<string, string | undefined> | undefined): void {
  overlay = { ...(next ?? {}) };
}

/** `base` with the current agent's overlay applied (undefined → key removed). */
export function currentAgentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Test seam. */
export function resetCurrentAgentEnvForTests(): void {
  overlay = {};
}
