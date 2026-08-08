/**
 * Native ACP guardrails — the shared policy model.
 *
 * A guardrail is a per-category disposition applied in the ACP client to a
 * deployed agent's tool calls: `deny` (block), `confirm` (surface a tappable
 * approve/deny on mobile), or `off`. Default-on, configurable per session.
 *
 * ⚠️ SOFT guardrail, NOT a security boundary — it only sees tool calls the
 * agent routes through the ACP client (permission requests + delegated
 * fs read/write). An in-process tool call, a `bypassPermissions` agent (no
 * permission requests), or a PTY agent (aider, bypasses ACP) slips it. Real
 * containment is server-side (scoped, revocable tokens; per-user containers).
 * The UI must present it as a safety net, never as a hard boundary.
 *
 * Spec: docs/superpowers/specs/2026-08-08-native-acp-guardrails-design.md.
 */

export type GuardrailDisposition = 'deny' | 'confirm' | 'off';

export type GuardrailCategory =
  | 'secretRead' // read of .env / *.key / *.pem / credentials-like files
  | 'destructiveShell' // rm -rf, git reset --hard, git clean -fdx, truncate/drop
  | 'protectedBranch' // commit / push to a shared/default branch
  | 'outwardIrreversible'; // force-push, publish/deploy/release, send

export type GuardrailPolicy = Record<GuardrailCategory, GuardrailDisposition>;

/** Stable order for UI rows + iteration. */
export const GUARDRAIL_CATEGORIES: readonly GuardrailCategory[] = [
  'secretRead',
  'destructiveShell',
  'protectedBranch',
  'outwardIrreversible',
];

export const GUARDRAIL_DISPOSITIONS: readonly GuardrailDisposition[] = ['deny', 'confirm', 'off'];

/** Default-on: safe by default (everything asks) but nothing hard-blocked, so a
 *  legitimate action is one tap away rather than a wall. */
export const DEFAULT_GUARDRAIL_POLICY: GuardrailPolicy = {
  secretRead: 'confirm',
  destructiveShell: 'confirm',
  protectedBranch: 'confirm',
  outwardIrreversible: 'confirm',
};

export interface GuardrailCategoryMeta {
  id: GuardrailCategory;
  /** Short label for a settings row. */
  label: string;
  /** One line describing what it catches — user-facing. */
  description: string;
}

/** Single source for the mobile settings copy + the backend/agent block reason. */
export const GUARDRAIL_CATEGORY_META: Record<GuardrailCategory, GuardrailCategoryMeta> = {
  secretRead: {
    id: 'secretRead',
    label: 'Reading secrets',
    description: 'Reading .env, key, or credential files.',
  },
  destructiveShell: {
    id: 'destructiveShell',
    label: 'Destructive commands',
    description: 'Bulk deletes, hard resets, and other irreversible shell actions.',
  },
  protectedBranch: {
    id: 'protectedBranch',
    label: 'Protected branches',
    description: 'Committing or pushing to a shared branch (main, master, release).',
  },
  outwardIrreversible: {
    id: 'outwardIrreversible',
    label: 'Outward & irreversible',
    description: 'Force-push, publish, deploy, or send — hard to undo.',
  },
};

export function isGuardrailDisposition(x: unknown): x is GuardrailDisposition {
  return x === 'deny' || x === 'confirm' || x === 'off';
}

/**
 * Coerce an untrusted value (a `~/.codeam/guardrails.json` blob, a wire payload,
 * a partial policy) into a complete policy, falling back to the default per
 * category. Absent/garbage → the full default (default-on).
 */
export function normalizeGuardrailPolicy(raw: unknown): GuardrailPolicy {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<GuardrailCategory, unknown>>;
  const out = {} as GuardrailPolicy;
  for (const cat of GUARDRAIL_CATEGORIES) {
    const v = src[cat];
    out[cat] = isGuardrailDisposition(v) ? v : DEFAULT_GUARDRAIL_POLICY[cat];
  }
  return out;
}

/** The wire command that pushes a live policy update to a running session. */
export const GUARDRAIL_CONFIGURE_COMMAND = 'guardrail_configure';
