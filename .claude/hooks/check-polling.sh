#!/usr/bin/env bash
# PreToolUse hook — block polling AND new SSE endpoints.
#
# This repo's realtime architecture is THREE existing SSE channels:
#   1. /api/users/me/stream            — per-user dashboard bus
#   2. /api/commands/output/stream     — agent output chunks
#   3. /api/commands/pending/stream    — command relay (plugin pull)
#
# New realtime signals belong as a new `type` / event variant on one
# of these existing channels — NOT a new endpoint, NOT a setInterval
# loop. See CLAUDE.md → "No polling — anywhere, for anything realtime".
set -euo pipefail

input="$(cat)"
tool_name="$(printf '%s' "$input" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_name",""))' 2>/dev/null || true)"

case "$tool_name" in
  Edit|Write|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

file_path="$(printf '%s' "$input" | python3 -c 'import sys,json; d=json.load(sys.stdin).get("tool_input",{}); print(d.get("file_path") or d.get("notebook_path") or "")' 2>/dev/null || true)"
payload="$(printf '%s' "$input" | python3 -c 'import sys,json; d=json.load(sys.stdin).get("tool_input",{}); print(d.get("new_string") or d.get("content") or d.get("new_source") or "")' 2>/dev/null || true)"

# Skip allowlisted contexts where timers are legitimate:
# - tests (jest/vitest fake timers, async test helpers)
# - animation / haptics (RN Animated, Reanimated, drivers)
# - vendored / generated / build artifacts
case "$file_path" in
  *__tests__/*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) exit 0 ;;
  */node_modules/*|*/dist/*|*/build/*|*/.next/*) exit 0 ;;
  */animations/*|*/animated/*) exit 0 ;;
esac

violations=""

# ── Polling patterns ─────────────────────────────────────────────
if printf '%s' "$payload" | grep -qE '\bsetInterval\s*\('; then
  violations="${violations}- setInterval(...) — recurring polling.\n"
fi
if printf '%s' "$payload" | grep -cE '\bsetTimeout\s*\(' | awk '{exit !($1>=3)}'; then
  violations="${violations}- 3+ setTimeout(...) calls in one change — looks like a polling re-arm.\n"
fi

# ── New SSE endpoint patterns ───────────────────────────────────
# Server-side: a new file (Write) or a diff that introduces
# `text/event-stream` is almost always a new SSE endpoint.
if printf '%s' "$payload" | grep -qE "text/event-stream"; then
  case "$file_path" in
    */users/me/stream*|*/commands/output/stream*|*/commands/pending/stream*) ;;
    *) violations="${violations}- text/event-stream header — looks like a new SSE endpoint.\n" ;;
  esac
fi

# Client-side: new EventSource pointing at a non-allowlisted URL.
if printf '%s' "$payload" | grep -qE 'new\s+EventSource\s*\('; then
  if ! printf '%s' "$payload" | grep -qE 'EventSource\([^)]*(users/me/stream|commands/output/stream|commands/pending/stream)'; then
    violations="${violations}- new EventSource(<non-canonical URL>) — looks like a new SSE consumer.\n"
  fi
fi

if [ -z "$violations" ]; then
  exit 0
fi

{
  printf 'BLOCKED — realtime architecture rule violation.\n\n'
  printf 'File: %s\n' "$file_path"
  printf 'Detected pattern(s):\n'
  printf '%b' "$violations"
  cat <<'BLOCK_MSG'

Realtime in this product runs on THREE existing SSE channels:
  - /api/users/me/stream            — per-user dashboard bus (useUserEventsSSE)
  - /api/commands/output/stream     — agent output (useOutputSSE)
  - /api/commands/pending/stream    — command relay (CLI / plugin pull)

Rules:
  - NO polling. Don't add setInterval / setTimeout re-arms to check
    state — route off an existing SSE event into a Zustand store.
  - NO new SSE endpoints. Pick the channel whose semantics fit your
    signal (per-user bus is the default for dashboard / live state)
    and ADD A NEW MESSAGE TYPE on it:
      1. Define a new variant on the channel's event union
         (e.g. UserEvent in apps/api-v2/src/common/types).
      2. Publish from the existing producer site.
      3. Handle the new type in the matching consumer hook + Zustand
         store mutator.

The CLI side mirrors this: the PTY data event is the realtime signal.
React in the existing data handler — don't schedule timer callbacks.

See CLAUDE.md → "No polling — anywhere, for anything realtime" for
the full rule + the documented exception (command-relay HTTP-poll
fallback, capped + back-off).

If a one-shot (non-recurring) setTimeout is genuinely needed (UI
debounce / animation), inline-justify with a comment and keep call
counts below 3 in the same diff.
BLOCK_MSG
} >&2
exit 2
