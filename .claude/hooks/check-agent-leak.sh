#!/usr/bin/env bash
# PreToolUse hook — block agent-specific code from leaking into the
# generic agent-agnostic surfaces.
#
# Architectural rule (CLAUDE.md): per-agent behavior lives under
# `apps/cli/src/agents/<agent>/` (and the matching strategy method
# in `apps/cli/src/agents/strategy.ts`). Code in shared layers
# (`apps/cli/src/services/`, `apps/cli/src/commands/start/handlers.ts`,
# the relay, the chunk protocol, the output service) must be agent-
# agnostic — every new agent (Claude, Codex, Aider, Cursor, future
# agents) plugs in through the strategy, not by adding branches in
# the shared services.
#
# When this hook fires, it means an edit to a shared file is about
# to introduce text that references a specific agent by name. The
# correct place for that logic is the per-agent strategy file. The
# hook prints a guide and blocks the write so the agent can move
# the code into the right place.
set -euo pipefail

input="$(cat)"
tool_name="$(printf '%s' "$input" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_name",""))' 2>/dev/null || true)"

case "$tool_name" in
  Edit|Write|MultiEdit) ;;
  *) exit 0 ;;
esac

file_path="$(printf '%s' "$input" | python3 -c 'import sys,json; d=json.load(sys.stdin).get("tool_input",{}); print(d.get("file_path") or "")' 2>/dev/null || true)"
payload="$(printf '%s' "$input" | python3 -c 'import sys,json; d=json.load(sys.stdin).get("tool_input",{}); print(d.get("new_string") or d.get("content") or "")' 2>/dev/null || true)"

# Only enforce the rule for shared agent-runtime surfaces. Anything
# under `apps/cli/src/agents/<x>/` is per-agent BY DEFINITION and
# is the correct home for agent-specific logic.
case "$file_path" in
  */apps/cli/src/services/agent.service.ts) ;;
  */apps/cli/src/services/output/*) ;;
  */apps/cli/src/services/command-relay.service.ts) ;;
  */apps/cli/src/services/pty/*) ;;
  */apps/cli/src/commands/start/handlers.ts) ;;
  */apps/cli/src/commands/start.ts) ;;
  */apps/cli/src/agents/strategy.ts) ;;
  */apps/cli/src/agents/registry.ts) ;;
  */packages/shared/src/protocol/*) ;;
  *) exit 0 ;;
esac

# Tests and per-agent files are exempt — tests legitimately mock
# specific agents, and the per-agent runtime files ARE the right
# place for the logic.
case "$file_path" in
  *__tests__/*|*.test.ts|*.spec.ts) exit 0 ;;
  */apps/cli/src/agents/claude/*) exit 0 ;;
  */apps/cli/src/agents/codex/*) exit 0 ;;
  */apps/cli/src/agents/aider/*) exit 0 ;;
  */apps/cli/src/agents/cursor/*) exit 0 ;;
  */apps/cli/src/agents/coderabbit/*) exit 0 ;;
esac

# Detect agent-specific identifiers in the new content. We look for
# word-boundary matches so "Anthropic Claude API" trips it but
# "agentic" / "ancillary" / "cursored" don't.
violations=""
add_violation() {
  violations="$violations
  - $1"
}

if printf '%s' "$payload" | grep -qiE '\b(claude code|claude_code|claude\.service|claudecode)\b'; then
  add_violation "Claude-specific reference ('claude code' / 'claude_code')"
elif printf '%s' "$payload" | grep -qE "['\"\`]claude['\"\`]"; then
  add_violation "Claude-specific literal ('claude')"
fi
if printf '%s' "$payload" | grep -qE "['\"\`]codex['\"\`]"; then
  add_violation "Codex-specific literal ('codex')"
fi
if printf '%s' "$payload" | grep -qE "['\"\`]aider['\"\`]"; then
  add_violation "Aider-specific literal ('aider')"
fi
if printf '%s' "$payload" | grep -qE "['\"\`]cursor['\"\`]"; then
  add_violation "Cursor-specific literal ('cursor')"
fi
if printf '%s' "$payload" | grep -qE "['\"\`]coderabbit['\"\`]"; then
  add_violation "CodeRabbit-specific literal ('coderabbit')"
fi

# `\x1b[200~` / `\x1b[201~` are bracketed-paste markers — used by
# Claude Code's TUI but NOT by every agent. If they appear in a
# shared file, the change is conflating Claude's input contract with
# the generic surface.
if printf '%s' "$payload" | grep -qE '\\x1[bB]\[20[01]~|\\033\[20[01]~'; then
  add_violation "Bracketed-paste marker (ESC[200~/ESC[201~) — Claude-TUI-specific wire shape"
fi

if [[ -z "$violations" ]]; then
  exit 0
fi

cat >&2 <<EOF
✗ Agent-specific code in a shared-agent file.

Target file: $file_path

Detected:$violations

Why this is blocked:
  Shared services (agent.service.ts, output/*, command-relay,
  pty/*, start/handlers.ts, strategy.ts, registry.ts, the shared
  protocol) run for EVERY agent — Claude, Codex, Aider, Cursor,
  and future ones. Adding a branch for one agent here means every
  new agent has to thread itself through this code path, and the
  next person reading the file has to mentally untangle which
  branch their agent hits.

Where it should live:
  apps/cli/src/agents/<agent>/runtime.ts        — strategy methods
  apps/cli/src/agents/<agent>/parsing.ts        — output handling
  apps/cli/src/agents/<agent>/credentials.ts    — auth flow
  apps/cli/src/agents/<agent>/installer.ts      — install steps

If the contract truly needs to be agent-aware, add an OPTIONAL
method to InteractiveAgentStrategy in strategy.ts (without an
agent name in the type), call it from the shared service, and
implement the override only on the agent that needs it. The
shared service stays agent-agnostic; the agent decides.

Example pattern: \`prepareInputWrites?(text)\` on the strategy +
\`this.runtime.prepareInputWrites?.(text) ?? <default>\` at the
call site.
EOF
exit 2
