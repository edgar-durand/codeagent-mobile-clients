# AGENTS.md

> **Canonical agent instructions for this repo live in [`CLAUDE.md`](./CLAUDE.md).** Read it first — this file is a cross-tool entry point that points there and surfaces the highest-signal rules inline.

This is the **client-side** repo: `codeam-cli` (npm), the VS Code / Cursor / Windsurf extension, the JetBrains plugin, and `@codeam/shared` (the wire protocol). The backend lives in the sibling [`codeagent-mobile`](https://github.com/edgar-durand/codeagent-mobile) repo.

## Non-negotiables (full detail in CLAUDE.md)

- **Releases are tag-triggered:** all three clients ship under ONE version line. `git tag vX.Y.Z && git push origin vX.Y.Z` publishes npm + VS Code Marketplace + Open VSX + JetBrains. Commits to `main` run CI but do NOT release.
- **Protocol code is shared:** parsing / pricing / chunk shapes change ONLY in `packages/shared` (`@codeam/shared`); both CLI and VS Code import through it.
- **No polling for realtime:** react inside the PTY/SSE event (`OutputService.push`), don't add `setTimeout` "check again" loops. The HTTP-polling fallback in `command-relay.service.ts` is the one documented exception.
- **Typing:** no `as unknown as` / `any` to silence TS — fix the source.

## Agent-failure messaging (2026-06-24 — `apps/cli/src/agents/acp/runner.ts`)

A turn must NEVER end silently or with a misleading status. Tests: `__tests__/agents/acp.failureBubble.test.ts`.

- **`failureBubble` is the sole arbiter**, keyed on the agent's OWN error.
- **The provider-outage bubble fires ONLY from the agent's error — NEVER from polling the status page.** A status-page incident can be live while the user's local agent is fine. The `checkProviderStatus` status-page catch-all was removed in `v2.42.0` for that false positive. The status page is the link *inside* the bubble, not a trigger.
- **Auth notice as a completed-turn reply** (`Not logged in · Please run /login` printed as plain text, turn ends cleanly) → caught by `replyIsAuthFailure` (≤200-char guard) → re-auth bubble + `reportCredentialInvalid`.
- **1M-context usage-credits gate** (`v2.43.0`): claude Code v2.1.x always sends the `context-1m` beta even on credit-less accounts → 429 "Usage credits required for 1M context" every turn (NOT Headroom — it forwards the beta unchanged). On-demand recovery only: `looksLike1mContextCreditsError` → offer a "Disable 1M context and continue" `select_prompt` → on tap, persist `disable1mContext`, re-spawn the ACP adapter with `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`, re-run the failed prompt. Never disabled for all users.

## Heartbeat must stay punctual

`command-relay.service.ts`'s 20 s heartbeat shares the event loop with the ACP turn — it must do ZERO synchronous I/O. The git branch is seeded once at `start()` then refreshed via async `detectCurrentBranchAsync` off the hot path (`v2.42.0`). A synchronous git spawn on the tick can starve the beat (the "LAST PING —" stall).

## Claude credential kinds (shared invariant with the backend)

`~/.claude/.credentials.json` MUST be a JSON blob. A bare setup-token (`sk-ant-oat01-…`) goes to the `CLAUDE_CODE_OAUTH_TOKEN` env var. The self-hosted guard is `isJsonBlob` in `apps/cli/src/commands/host/agent-provisioning.ts`; keep it byte-compatible with the backend's codespace `getAuthSnippet`.
