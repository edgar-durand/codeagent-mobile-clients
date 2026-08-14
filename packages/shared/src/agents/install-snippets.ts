/**
 * Canonical per-agent CLI **install** snippets.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 * Until now the only copy of these shell recipes lived inside the backend's
 * codespace provisioning strategies — one `getInstallSnippet()` per
 * `…ProvisioningStrategy` in
 * `codeagent-mobile/apps/api-v2/src/codespaces/agent.ts`. That made them
 * unreachable from the clients repo, so the CLI could never be tested against
 * the REAL command a box actually runs: the `switch_agent` install path only
 * ever saw a snippet handed to it over the wire at runtime.
 *
 * That gap is exactly how the **stale-PATH / half-finished-install** failure
 * class (fleet-1, 2026-08-14) reached production: `npm install -g @openai/codex`
 * succeeded, but the long-running CLI daemon's PATH predated the npm
 * global-prefix bin dir, so the post-install probe reported "installed but its
 * binary never appeared on PATH" — forever. No CI test could have caught it,
 * because no CI test could run the real install.
 *
 * These strings are now **canonical HERE**. `apps/cli/__tests__/integration/
 * agent-install.int.test.ts` runs each one for real, inside a container with a
 * deliberately minimal (systemd-like) PATH, and then drives the REAL adapter
 * probe from a single long-running node process.
 *
 * ─── api-v2 migration (deliberate follow-up, NOT done yet) ───────────────────
 * The backend still owns its own copies. At the next `@codeam/shared` pin bump
 * in api-v2, change exactly ONE file —
 *
 *     codeagent-mobile/apps/api-v2/src/codespaces/agent.ts
 *
 * — so every `…ProvisioningStrategy.getInstallSnippet()` returns
 * `INSTALL_SNIPPETS[<agentId>]` imported from `@codeam/shared` instead of an
 * inline template literal. The `getAuthSnippet()` half stays in api-v2: it is
 * credential-bearing and must never be mirrored into a package the clients
 * bundle.
 *
 * ─── Invariants ──────────────────────────────────────────────────────────────
 * • **Install ONLY.** Every credential/auth line from the backend strategies is
 *   deliberately excluded — no token, key, or secret substitution variable may
 *   ever appear here (asserted by `__tests__/agents-install-snippets.test.ts`).
 * • **Idempotent.** Each snippet is `command -v`-guarded, so re-running it is
 *   always safe — that is what makes the `switch-agent.ts` retry-once recovery
 *   for the half-finished-bin-link class legitimate.
 * • **Verbatim.** These are byte-for-byte ports of the api-v2 snippets. Do not
 *   "clean them up" independently — a divergence means a codespace and a
 *   self-hosted switch install different things.
 * • `claude` is absent ON PURPOSE: its binary ships as an optional platform
 *   dependency of `@anthropic-ai/claude-agent-sdk` (installed with the CLI
 *   itself), so there is no separate install recipe to run.
 */

import type { AgentId } from './types';

/**
 * `npm install -g @openai/codex` → the binary lands in npm's global-prefix bin
 * dir (`~/.local/bin` on a per-user prefix — the fleet-1 condition).
 */
const CODEX = `
if ! command -v codex >/dev/null 2>&1; then
  npm install -g @openai/codex >/dev/null
fi`;

/** `npm install -g @google/gemini-cli` — same global-prefix delivery as codex. */
const GEMINI = `
if ! command -v gemini >/dev/null 2>&1; then
  npm install -g @google/gemini-cli >/dev/null
fi`;

/**
 * Official curl installer (Node-based). Like the Cursor snippet: retry the
 * unguarded network pipe once so a transient blip doesn't abort the whole
 * bootstrap under `set -euo pipefail`, and `[ERROR]`-prefix the final failure
 * for the stderr error-detector. ⚠️ The installer drops the binary under
 * ~/.kimi-code/bin, which is NOT on the default PATH — so `kimi acp` spawns
 * with ENOENT unless PATH is extended for the SESSION (the agent spawns from
 * this shell) AND persisted to ~/.bashrc (future logins).
 */
const KIMI = `
if ! command -v kimi >/dev/null 2>&1; then
  curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash \\
    || { echo '[codeam:step] kimi_install_retry' >&2; sleep 2; curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash; } \\
    || { echo '[ERROR] Kimi Code install failed (code.kimi.com/kimi-code/install.sh)' >&2; exit 1; }
  echo 'export PATH="$HOME/.kimi-code/bin:$PATH"' >> ~/.bashrc
  export PATH="$HOME/.kimi-code/bin:$PATH"
fi
# Integrity guard: the installer can leave a TRUNCATED binary (SIGSEGV on run)
# when the ~157MB download is interrupted mid-bootstrap — the ELF ends up
# missing its section headers and every \`kimi\` invocation segfaults, so the ACP
# adapter dies. Verify \`kimi\` actually runs; re-install once if it doesn't.
if ! kimi --version >/dev/null 2>&1; then
  echo '[codeam:step] kimi_binary_broken_reinstall' >&2
  curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash || true
  export PATH="$HOME/.kimi-code/bin:$PATH"
fi`;

/**
 * Official headless installer. `cursor-agent` runs headless; the installer
 * drops the binary under ~/.local/bin, so extend PATH for the session AND
 * persist it to ~/.bashrc.
 */
const CURSOR = `
if ! command -v cursor-agent >/dev/null 2>&1; then
  # Retry the installer once — under the bootstrap's \`set -euo pipefail\`
  # a single transient failure of this unguarded network pipe would
  # otherwise abort the whole bootstrap with a bare exit 1. The
  # \`[ERROR]\` prefix on final failure is picked up by the stderr
  # error-detector and the captured summary.
  curl https://cursor.com/install -fsS | bash \\
    || { echo '[codeam:step] cursor_install_retry' >&2; sleep 2; curl https://cursor.com/install -fsS | bash; } \\
    || { echo '[ERROR] cursor-agent install failed (cursor.com/install)' >&2; exit 1; }
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
  export PATH="$HOME/.local/bin:$PATH"
fi`;

/**
 * Baked in the box image → `command -v` short-circuits; the guard only installs
 * on a bare box. Official installer drops the binary under ~/.opencode/bin.
 */
const OPENCODE = `
if ! command -v opencode >/dev/null 2>&1; then
  curl -fsSL https://opencode.ai/install | bash \\
    || { echo '[codeam:step] opencode_install_retry' >&2; sleep 2; curl -fsSL https://opencode.ai/install | bash; } \\
    || { echo '[ERROR] opencode install failed (opencode.ai/install)' >&2; exit 1; }
  echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> ~/.bashrc
  export PATH="$HOME/.opencode/bin:$PATH"
fi`;

/**
 * Baked in the image → `command -v` short-circuits. The guard only installs on
 * a bare box that somehow lacks it. Retry once (unguarded network pipe).
 */
const AIDER = `
if ! command -v aider >/dev/null 2>&1; then
  pip install --no-cache-dir --break-system-packages aider-chat \\
    || { echo '[codeam:step] aider_install_retry' >&2; sleep 2; pip install --no-cache-dir --break-system-packages aider-chat; } \\
    || { echo '[ERROR] aider install failed (pip aider-chat)' >&2; exit 1; }
fi`;

/**
 * ⚠️ CodeRabbit's codespace snippet is deliberately a **no-op**: it is a
 * reviewer added to an EXISTING session, so the codespace only needs the
 * credential — the reviewer CLI is installed on demand CLI-side by
 * `apps/cli/src/agents/coderabbit/installer.ts` (`ensureCoderabbitInstalled`,
 * which also provisions the installer's `unzip`/`git` prerequisites).
 *
 * Ported verbatim so this map stays a faithful mirror of api-v2, but consumers
 * that need a REAL install for coderabbit must use the CLI-side installer —
 * see {@link isNoopInstallSnippet}.
 */
const CODERABBIT = `echo '[codeam:step] coderabbit_reviewer_credential_only'`;

/**
 * The canonical install recipe per agent. `Partial` because not every agent has
 * one: `claude` ships its binary with the SDK, and `copilot` has no
 * provisioning strategy yet.
 */
export const INSTALL_SNIPPETS: Readonly<Partial<Record<AgentId, string>>> = Object.freeze({
  codex: CODEX,
  gemini: GEMINI,
  kimi: KIMI,
  cursor: CURSOR,
  opencode: OPENCODE,
  aider: AIDER,
  coderabbit: CODERABBIT,
});

/**
 * Agents whose canonical snippet actually installs something. Excludes
 * `coderabbit` (credential-only no-op — see {@link INSTALL_SNIPPETS}).
 *
 * This is the list the real-install integration gate iterates.
 */
export function installableAgentIds(): AgentId[] {
  return (Object.keys(INSTALL_SNIPPETS) as AgentId[]).filter(
    (id) => !isNoopInstallSnippet(INSTALL_SNIPPETS[id]),
  );
}

/**
 * True when a snippet performs no installation at all (a bare marker `echo`).
 * Callers that need a real binary must fall back to the agent's own CLI-side
 * installer instead of running the snippet.
 */
export function isNoopInstallSnippet(snippet: string | undefined): boolean {
  if (!snippet) return true;
  return /^\s*echo\s/.test(snippet) && !/\n/.test(snippet.trim());
}
