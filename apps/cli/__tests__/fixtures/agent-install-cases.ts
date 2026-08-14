/**
 * Per-agent decision table for the real-install gate.
 *
 * Lives under `__tests__/fixtures/` (excluded from the vitest glob — no
 * `describe`/`it` here) so BOTH consumers can import it:
 *
 *  • `__tests__/integration/agent-install.int.test.ts` — the Docker-gated gate
 *    that actually runs each case. Skipped without `RUN_AGENT_INSTALL_INT=1`.
 *  • `__tests__/agents/agent-install-cases.test.ts` — a plain unit test that
 *    asserts this table covers every `INSTALL_SNIPPETS` key. That assertion
 *    MUST run in normal CI: if it only lived inside the Docker-gated suite, a
 *    new agent could be added to the canonical snippets with no case recorded
 *    and nothing would notice on a PR.
 */

/** A case the gate runs for real, end to end. */
export interface RealCase {
  kind: 'real';
  /** Why this agent's install is interesting — surfaced in the test name. */
  note: string;
}

/** A case the gate deliberately does NOT run — always announced, never silent. */
export interface TrackedSkip {
  kind: 'tracked-skip';
  reason: string;
}

export type AgentCase = RealCase | TrackedSkip;

/**
 * EVERY key of `INSTALL_SNIPPETS` must appear here. A new agent added to the
 * canonical snippet map without a decision recorded here fails the unit test —
 * a silent gap is exactly how the stale-PATH class escaped before.
 */
export const AGENT_INSTALL_CASES: Record<string, AgentCase> = {
  codex: {
    kind: 'real',
    note: 'npm -g into the per-user prefix — the original fleet-1 binary',
  },
  gemini: { kind: 'real', note: 'npm -g into the per-user prefix' },
  kimi: { kind: 'real', note: 'curl installer → ~/.kimi-code/bin (off PATH by construction)' },
  cursor: {
    kind: 'real',
    note: 'curl installer → ~/.local/bin; adapter spec is cached with the BARE name pre-install',
  },
  opencode: { kind: 'real', note: 'curl installer → ~/.opencode/bin (off PATH by construction)' },
  aider: {
    kind: 'real',
    note: 'pip falls back to a --user install → ~/.local/bin; probed via the runtime prepareLaunch',
  },
  coderabbit: {
    kind: 'real',
    note: "canonical snippet is credential-only, so the REAL path is the CLI's own installer",
  },
};
