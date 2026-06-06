# ACP runtime — `agents/acp/`

A single, agent-agnostic runtime that drives any [Agent Client Protocol](https://agentclientprotocol.com)-compatible agent over JSON-RPC stdio. Replaces the hand-rolled per-agent PTY parsers (`agents/claude/`, `agents/codex/`, `agents/cursor/`) for agents that ship an ACP adapter, on a global env toggle.

## Why this exists

The legacy per-agent runtimes spawn the agent in a PTY and parse its TUI output back into typed chunks via hand-tuned regex (chrome detection, selector detection, banner detection, etc.). Every new agent = new parser + tests + ongoing maintenance, and whole classes of bugs (prompt corruption, parser races, stale option metadata — see [`rafaelph#253`](https://github.com/edgar-durand/codeagent-mobile-clients/issues/253), [`rafaelph#255`](https://github.com/edgar-durand/codeagent-mobile-clients/issues/255)) are structurally possible because we're reassembling messages from PTY text.

ACP gives us typed messages straight from the agent — `session/update`, `session/request_permission`, `fs/read_text_file`, `terminal/*`. The same five mapper functions cover every ACP-compatible agent. Adding a new agent is **3 lines** in [`adapters.ts`](./adapters.ts).

## Status

| Agent  | Adapter source                             | Phase 1 |
| ------ | ------------------------------------------ | :-----: |
| Claude | `@agentclientprotocol/claude-agent-acp`    |    ✅    |
| Codex  | `@agentclientprotocol/codex-acp`           |    ✅    |
| Cursor | `cursor-agent-acp`                         |    ✅    |
| Gemini | native (`gemini --acp`)                    |    ✅    |

Phase 1 supports:

- `start_task` → ACP `session/prompt`
- `stop_task` / `escape_key` → ACP `session/cancel`
- `session/update` (text / thought / tool_call / tool_call_update) → existing streaming-chunk endpoint
- `session/request_permission` → existing awaiting-answer endpoint with 1.5 s polling
- `fs/readTextFile` + `fs/writeTextFile` from the agent → local file I/O

Phase 2 backlog (currently `not supported in Phase 1 ACP mode` notice in the relay log):

- `resume_session`, `change_model`, `list_models`, `summarize`, `provide_input`, `select_option`
- ACP `terminal/*` (capability declared `false` for now)
- Plan / usage_update UI surfacing

## How to turn it on (smoke test)

1. Make sure the agent's CLI is on PATH — the adapter is a thin protocol bridge, the real agent process is still the one doing the work:
   - Claude: `claude --version`
   - Codex: `codex --version`
   - Cursor: `cursor-agent --version`
2. Pair the CLI with mobile as usual (`codeam pair --agent=claude`), but pass the env flag:
   ```sh
   CODEAM_ACP_ENABLED=1 codeam pair --agent=claude
   ```
   On startup the CLI prints `Starting claude via ACP adapter (claude)…` instead of the usual Claude welcome banner — that's how you know the fork took.
3. Send a prompt from mobile. The agent's response streams back as text chunks identical in shape to the PTY pipeline; the mobile / web UI renders them with no client-side changes.
4. Trigger a permission-requiring action (e.g. tool that wants to run a shell command). The mobile sheet pops up the same `awaiting-answer` flow that the PTY path used — pick an option and the reply round-trips back to ACP via the pending-answer poll.

If the adapter package isn't installed or the underlying CLI is missing, the runner falls back to the PTY pipeline with a one-line `CODEAM_ACP_ENABLED is set but no ACP adapter is registered…` info nudge — no crash, no degraded session.

## File map

| File             | Responsibility                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `runner.ts`      | Top-level orchestrator. Spawns the client, wires the publisher, drives the command relay.   |
| `client.ts`      | SDK wrapper. Spawns the adapter, bridges Node stdio to the SDK's web-stream Stream surface. |
| `publisher.ts`   | HTTP publisher — POSTs streaming-chunks + awaiting-answer + polls pending-answer.           |
| `mappers.ts`     | Pure functions: ACP `SessionUpdate` / `RequestPermissionRequest` → existing wire shapes.    |
| `adapters.ts`    | Per-agent adapter spec registry. Adding an agent = one entry.                               |

## Adding a new ACP-compatible agent

Two shapes, depending on whether the agent ships an npm adapter or speaks ACP natively.

### Shape A — npm-bundled adapter

Adapters like `@agentclientprotocol/claude-agent-acp` are pulled in as regular CLI deps so the user gets them for free with `npm i -g codeam-cli`.

1. `npm install <adapter-package>` in `apps/cli/`.
2. Add an entry to `REGISTRY` in [`adapters.ts`](./adapters.ts) keyed by the agent's `AgentId`:
   ```ts
   foo: () => {
     const bin = resolveBin('@acme/foo-acp', 'foo-acp');
     if (!bin) return null;
     return {
       command: process.execPath,
       args: [bin],
       requiresAgentBinary: 'foo',
     };
   },
   ```

### Shape B — native ACP (no adapter package)

Many agents now speak ACP directly via a CLI flag (Gemini's `--acp`, etc.). No npm package needed — just spawn the user's installed binary.

1. Add an entry pointing at the binary on PATH:
   ```ts
   gemini: () => ({
     command: 'gemini',
     args: ['--acp'],
     requiresAgentBinary: 'gemini',
   }),
   ```
2. Ship. The dispatch in [`start.ts`](../../commands/start.ts) picks it up the next time `CODEAM_ACP_ENABLED=1` is set for that agent.

No new runtime files, no parser per agent, no UI changes on mobile.
