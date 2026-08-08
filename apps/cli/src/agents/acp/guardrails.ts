import {
  GUARDRAIL_CATEGORIES,
  GUARDRAIL_CATEGORY_META,
  type GuardrailCategory,
  type GuardrailPolicy,
} from '@codeam/shared';

/**
 * Native ACP guardrails — the pure decision function, a generalization of
 * `internalPathPermissionOutcome` (see ./internal-paths.ts). Given an ACP
 * permission request + the session's policy, it classifies the tool call into a
 * guardrail category (by matching `title` + serialized `rawInput`) and applies
 * the strongest active disposition:
 *   - `deny`    → an ACP reject/cancel outcome (block the call).
 *   - `confirm` → a sentinel; the runner skips auto-approve and routes the call
 *                 to the interactive approve/deny prompt on mobile.
 *   - none / `off` → null (the call proceeds as before).
 *
 * Detection is deliberately conservative (a handful of unambiguous shells +
 * secret-path shapes) — a false negative is a missed nudge, a false positive is
 * an annoying confirm on a benign call, so we bias toward precision.
 *
 * SOFT guardrail (see @codeam/shared guardrails doc): only sees tool calls the
 * agent routes through the ACP client. Enforced on MANAGED deploys only (caller
 * gates on `!isLocalSession()`).
 */

export interface GuardrailPermissionRequest {
  toolCall: { title?: string | null; kind?: string | null; rawInput?: unknown };
  options: ReadonlyArray<{ optionId: string; kind: string }>;
}

export type GuardrailDecision =
  | {
      kind: 'deny';
      category: GuardrailCategory;
      reason: string;
      outcome: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } };
    }
  | { kind: 'confirm'; category: GuardrailCategory; reason: string }
  | null;

// Secret-file shapes (read or reference). Each `.env`/key/credential token must
// be preceded by a path separator, quote, `=`, or whitespace so `process.env`
// and `import.meta.env` (no separator before `.env`) never match.
const SECRET_RE =
  /(^|[\s"'`=(/\\])(\.env(\.[\w.-]+)?|[\w.-]+\.(pem|key|pfx|p12|jks|keystore)|id_rsa|id_ed25519|\.npmrc|\.pgpass|\.netrc|\.git-credentials|kubeconfig|credentials(\.[\w-]+)?)\b/i;

const DESTRUCTIVE_RES: RegExp[] = [
  /\brm\s+-[a-z]*f/i, // rm -rf / -fr / -f
  /\brm\s+[^\n]*--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+checkout\s+--\s+\./i, // discard all local changes
  /\bshred\b/i,
  /\btruncate\s+-s\s*0/i,
  /\b(drop|truncate)\s+(table|database)\b/i,
  /\bmkfs\b/i,
  /\bdd\b[^\n]*\bof=/i,
];

const PROTECTED_BRANCHES = 'main|master|develop|development|release[\\w./-]*|prod|production';
const PROTECTED_PUSH_RE = new RegExp(`\\bgit\\s+push\\b[^\\n]*\\b(${PROTECTED_BRANCHES})\\b`, 'i');

const OUTWARD_RES: RegExp[] = [
  /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|(?:^|\s)-f(?:\s|$))/i,
  /\b(npm|yarn|pnpm)\s+publish\b/i,
  /\bgh\s+release\s+create\b/i,
  /\bgit\s+push\b[^\n]*--tags\b/i,
  /\bvercel\b[^\n]*(--prod|deploy)/i,
  /\bnetlify\s+deploy\b/i,
  /\beas\s+(submit|build)\b/i,
];

function haystack(call: GuardrailPermissionRequest['toolCall']): string {
  let s = typeof call.title === 'string' ? call.title : '';
  if (call.rawInput != null) {
    try {
      s += '\n' + JSON.stringify(call.rawInput);
    } catch {
      /* unserializable — title-only */
    }
  }
  return s;
}

function matchedCategories(hay: string): Set<GuardrailCategory> {
  const m = new Set<GuardrailCategory>();
  if (SECRET_RE.test(hay)) m.add('secretRead');
  if (DESTRUCTIVE_RES.some((re) => re.test(hay))) m.add('destructiveShell');
  if (OUTWARD_RES.some((re) => re.test(hay))) m.add('outwardIrreversible');
  if (PROTECTED_PUSH_RE.test(hay)) m.add('protectedBranch');
  return m;
}

function rejectOutcome(
  options: GuardrailPermissionRequest['options'],
): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  const reject =
    options.find((o) => o.kind === 'reject_always') ?? options.find((o) => o.kind === 'reject_once');
  return reject
    ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/** True if this tool call touches a secret file — used at the fs read/write seam
 *  (which has no interactive channel) for a `deny`-only belt. */
export function toolPathIsSecret(p: string | null | undefined): boolean {
  return !!p && SECRET_RE.test(p);
}

/** Surfaced to the agent when the fs-seam belt blocks a secret read under
 *  `secretRead: 'deny'`. */
export const GUARDRAIL_SECRET_READ_BLOCK_REASON =
  "Reading this secret file is blocked by this session's guardrails " +
  '(Reading secrets = Deny). Adjust it in the session Guardrails settings if intended.';

export function guardrailDecision(
  request: GuardrailPermissionRequest,
  policy: GuardrailPolicy,
): GuardrailDecision {
  const hay = haystack(request.toolCall);
  if (!hay) return null;
  const matched = matchedCategories(hay);
  if (matched.size === 0) return null;

  // Strongest active disposition among all matched categories: deny > confirm >
  // off. Iterate in the stable GUARDRAIL_CATEGORIES order for determinism.
  let denyCat: GuardrailCategory | undefined;
  let confirmCat: GuardrailCategory | undefined;
  for (const cat of GUARDRAIL_CATEGORIES) {
    if (!matched.has(cat)) continue;
    const d = policy[cat];
    if (d === 'deny') {
      denyCat = cat;
      break; // deny is the strongest — no need to look further
    }
    if (d === 'confirm' && !confirmCat) confirmCat = cat;
  }

  if (denyCat) {
    return {
      kind: 'deny',
      category: denyCat,
      reason: GUARDRAIL_CATEGORY_META[denyCat].description,
      outcome: rejectOutcome(request.options),
    };
  }
  if (confirmCat) {
    return { kind: 'confirm', category: confirmCat, reason: GUARDRAIL_CATEGORY_META[confirmCat].description };
  }
  return null; // every matched category is 'off'
}
