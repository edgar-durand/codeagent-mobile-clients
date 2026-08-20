import * as path from 'node:path';
import * as os from 'node:os';

/**
 * CodeAgent platform-internals guard — the AGENT-AGNOSTIC, ACP-provided version
 * of the "don't expose CodeAgent's own runtime files" rule.
 *
 * It runs in the ACP CLIENT (this CLI) — the single component EVERY ACP agent
 * (claude / codex / gemini / cursor / opencode) routes through — so one
 * implementation covers all of them, instead of a Claude-only `settings.json`
 * rule. Enforced at two ACP seams:
 *   1. `session/request_permission` (runner): deny tool calls (bash cat/ls,
 *      writes, edits) whose input references an internal path — even under
 *      codespace auto-approve, since the agent still asks the client first.
 *   2. `fs/read_text_file` + `fs/write_text_file` (client): reject reads/writes
 *      of internal paths the adapter delegates to the client.
 *
 * ⚠️ SCOPE — accidental-disclosure / casual-exploration guardrail (Rafael,
 * 2026-07-28: "show me the home folder" listed `~/.codeam` internals). NOT an
 * absolute boundary: an agent that reads fully in-process (no permission request,
 * no fs delegation) can slip through, and a PTY agent (aider) bypasses ACP
 * entirely. That's acceptable because the REAL secrets are server-side and each
 * user runs in their own per-user container (the box holds only short-lived,
 * per-user-scoped, revocable tokens). Do NOT rely on this to protect a secret.
 *
 * Applied on MANAGED deploys only (the caller gates on `!isLocalSession()`) — on
 * a user's own local machine `~/.codeam` is the user's own config, not ours.
 */

/**
 * Substring tokens that unambiguously denote CodeAgent platform internals, for
 * matching against arbitrary tool input (a bash command string, a Read path,
 * a glob). `.codeam` matches `~/.codeam/**` and `.codeam-host.log` but NOT
 * `/tmp/codeam-node20` (no leading dot); `bd` commands (`bd ready`,
 * `bd remember …`) never contain `.codeam`, so beads keeps working. We
 * deliberately do NOT match a bare `.beads` here — a project's own `./.beads`
 * is legitimate; the home `~/.beads` is caught by {@link pathIsInternal}.
 */
const INTERNAL_TOKENS = ['.codeam', 'house-claude'];

/**
 * ACP ToolKinds whose `rawInput`/`title` carry free-form PROSE ABOUT the work —
 * a plan awaiting approval (`switch_mode`, e.g. Claude's ExitPlanMode with
 * `rawInput.plan` = the whole plan text) or a thought (`think`) — not a path or
 * command the tool will touch. Their text must NEVER be scanned for internal
 * tokens: on 2026-08-19 a plan that merely PRINTED the agent's own cwd
 * (`/home/box/.codeam/house-claude/…`) made the guard silently auto-reject the
 * plan-approval prompt, the agent told the user THE USER rejected it, plan mode
 * wedged for the rest of the session, and a source file was destroyed while the
 * agent probed the broken state. Real file access declared by such a call is
 * still caught via the structured `locations[].path` field.
 */
const PROSE_ONLY_TOOL_KINDS = new Set(['think', 'switch_mode']);

/** True when the tool call's kind marks its input as prose (see above). */
export function isProseOnlyToolKind(kind: string | null | undefined): boolean {
  return kind != null && PROSE_ONLY_TOOL_KINDS.has(kind);
}

/**
 * The per-deploy WORKSPACE lives at `~/.codeam/self-hosted/<deployId>/` — that
 * subtree is the USER's cloned project (a warm codespace / self-hosted box
 * clones repos there), NOT a CodeAgent internal. Its path literally contains
 * `.codeam`, so the naive `.codeam` substring token would false-flag EVERY tool
 * call whose cwd/paths sit inside the workspace. ⚠️ Rafael, 2026-08-05: in a warm
 * codespace, every `git commit` / edit / read was denied in MANUAL permission
 * mode (in AUTO the agent uses `bypassPermissions` and never asks the client, so
 * the guard never ran — hence "manual denies, auto works"). Neutralize the
 * self-hosted workspace prefix before the internal-token scan.
 */
const SELF_HOSTED_WORKSPACE_RE = /\.codeam[/\\]self-hosted/gi;

/** True if arbitrary text (bash command, serialized tool input) references an internal path. */
export function textReferencesInternal(text: string | null | undefined): boolean {
  if (!text) return false;
  const scrubbed = text.replace(SELF_HOSTED_WORKSPACE_RE, ' ');
  return INTERNAL_TOKENS.some((t) => scrubbed.includes(t));
}

/**
 * Precise absolute-path check for the fs read/write seam: within `~/.codeam`,
 * `~/.beads`, `~/.codeam-host.log`, or any `house-claude` directory.
 */
export function pathIsInternal(p: string | null | undefined, homeDir: string = os.homedir()): boolean {
  if (!p) return false;
  const abs = path.resolve(p);
  const home = path.resolve(homeDir);
  const within = (root: string) => abs === root || abs.startsWith(root + path.sep);
  // The user's cloned project lives under ~/.codeam/self-hosted/<deployId>/ — it
  // is NOT an internal (see SELF_HOSTED_WORKSPACE_RE). Must be checked BEFORE the
  // ~/.codeam catch-all below, which would otherwise swallow the whole workspace.
  if (within(path.join(home, '.codeam', 'self-hosted'))) return false;
  return (
    within(path.join(home, '.codeam')) ||
    within(path.join(home, '.beads')) ||
    abs === path.join(home, '.codeam-host.log') ||
    abs.includes(`${path.sep}house-claude${path.sep}`) ||
    abs.endsWith(`${path.sep}house-claude`)
  );
}

/**
 * Inspect an ACP permission request's tool call for a reference to an internal
 * path. Checks the structured `locations[].path` field first (real paths, any
 * kind), then — ONLY for tool kinds that actually operate on paths/commands
 * (read/edit/delete/move/search/execute/fetch/other) — serializes `rawInput`
 * (the bash command / file path / glob) plus the human `title` and matches the
 * internal tokens. Prose-only kinds ({@link isProseOnlyToolKind}) are exempt
 * from the free-text scan: an incidental internal-path MENTION inside plan text
 * is not a file access (the 2026-08-19 ExitPlanMode silent-rejection P0).
 */
export function toolCallReferencesInternal(
  call: {
    title?: string | null;
    kind?: string | null;
    rawInput?: unknown;
    locations?: ReadonlyArray<{ path: string }> | null;
  },
  homeDir?: string,
): boolean {
  // Structured path field — authoritative for EVERY kind, prose ones included.
  if (call.locations?.some((l) => pathIsInternal(l.path, homeDir))) return true;
  // Free-text scan only for kinds whose input IS a path/command.
  if (isProseOnlyToolKind(call.kind)) return false;
  if (textReferencesInternal(call.title)) return true;
  if (call.rawInput != null) {
    try {
      return textReferencesInternal(JSON.stringify(call.rawInput));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The REAL permission decision the ACP runner's `onRequestPermission` uses: given
 * a permission request, return the ACP outcome that DENIES it when it targets an
 * internal path (pick the broadest `reject_*` option; if the agent offers none,
 * `cancelled` aborts the tool), or `null` when the request is fine (the caller
 * then proceeds to auto-approve / interactive). Pure + exported so the guard's
 * decision is tested exactly as the handler runs it.
 */
export function internalPathPermissionOutcome(
  request: {
    toolCall: {
      title?: string | null;
      kind?: string | null;
      rawInput?: unknown;
      locations?: ReadonlyArray<{ path: string }> | null;
    };
    options: ReadonlyArray<{ optionId: string; kind: string }>;
  },
  homeDir?: string,
):
  | { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }
  | null {
  if (!toolCallReferencesInternal(request.toolCall, homeDir)) return null;
  // Prefer reject_ONCE: the guard re-evaluates every call anyway, and a
  // `reject_always` permanently poisons the tool for the whole session (the
  // 2026-08-19 plan-mode wedge). One blocked call must never disable a tool.
  const reject =
    request.options.find((o) => o.kind === 'reject_once') ??
    request.options.find((o) => o.kind === 'reject_always');
  if (reject) return { outcome: { outcome: 'selected', optionId: reject.optionId } };
  return { outcome: { outcome: 'cancelled' } };
}

/** User-facing reason surfaced to the agent when a call is blocked. */
export const INTERNAL_BLOCK_REASON =
  "This path is a CodeAgent platform internal (CodeAgent's own runtime plumbing, " +
  "not part of the user's project) and is off-limits. Continue with the user's own project files.";
