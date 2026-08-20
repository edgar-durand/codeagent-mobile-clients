import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { GuardrailPolicy } from '@codeam/shared';
import { log } from '../../services/logger';
import { internalPathPermissionOutcome } from './internal-paths';
import { guardrailDecision, type GuardrailDecision } from './guardrails';
import { mapPermissionRequest } from './mappers';

/**
 * The `session/request_permission` decision path, extracted from the runner so
 * the FULL gate (internal-path guard → guardrails → AUTO auto-approve →
 * interactive prompt) is unit-testable exactly as it runs in production.
 *
 * ⚠️ HARD RULE — an auto-decision is NEVER silent. Every auto-REJECT publishes
 * an informational chat line naming what was blocked and why, and stating that
 * it was CodeAgent's decision, not the user's. On 2026-08-19 the internal-path
 * guard silently rejected an ExitPlanMode approval (the PLAN TEXT mentioned
 * `/home/box/.codeam/house-claude/…`): no prompt ever reached the phone, the
 * agent told the user THE USER had rejected it, plan mode wedged for the rest
 * of the session, and a source file was destroyed while the agent probed the
 * broken state. The guard itself no longer scans prose payloads (see
 * ./internal-paths.ts), and this module guarantees any residual auto-deny is
 * visible in chat.
 */

/** One ACP permission option (subset of the SDK's PermissionOption). */
export interface AcpPermissionOption {
  optionId: string;
  kind: string;
}

/**
 * AUTO-mode option picker: choose the broadest "allow" grant (allow_always,
 * else allow_once) from an ACP permission request's options, or null when the
 * agent offers no allow option (then the caller falls back to interactive).
 * Pure + exported so the auto-approve decision is unit-tested without spinning
 * up a full ACP session.
 */
export function pickAllowOption<T extends AcpPermissionOption>(options: readonly T[]): T | null {
  return (
    options.find((o) => o.kind === 'allow_always') ??
    options.find((o) => o.kind === 'allow_once') ??
    null
  );
}

/** Short human handle for the blocked tool call in the notice line. */
function describeToolCallForNotice(toolCall: RequestPermissionRequest['toolCall']): string {
  const title = toolCall.title?.trim();
  return title ? `"${title}"` : 'a tool call';
}

/** Chat line published when the internal-path guard auto-denies a call. */
export function internalBlockNotice(toolCall: RequestPermissionRequest['toolCall']): string {
  return (
    `⛔ CodeAgent auto-blocked ${describeToolCallForNotice(toolCall)} — it targets ` +
    "CodeAgent's own runtime files (~/.codeam), which are off-limits to the agent. " +
    'This was an automatic block by CodeAgent, not a rejection by you.'
  );
}

/** Chat line published when a guardrail set to Deny auto-denies a call. */
export function guardrailBlockNotice(
  decision: Extract<NonNullable<GuardrailDecision>, { kind: 'deny' }>,
  toolCall: RequestPermissionRequest['toolCall'],
): string {
  return (
    `⛔ Guardrail auto-blocked ${describeToolCallForNotice(toolCall)} — ${decision.reason} ` +
    `This session's "${decision.category}" guardrail is set to Deny (adjust it in the session's ` +
    'Guardrails settings if intended). This was an automatic block, not a rejection by you.'
  );
}

export interface PermissionGateDeps {
  /** AUTO mode (headless / codespace): auto-pick an allow option. */
  autoApprovePermissions: boolean;
  /** Local session ⇒ neither internals guard nor guardrails apply. */
  isLocal: () => boolean;
  /** The session's guardrail policy (read per request — it's user-editable). */
  getPolicy: () => GuardrailPolicy;
  publisher: {
    publishAwaitingAnswer(
      event: ReturnType<typeof mapPermissionRequest>['event'],
    ): Promise<void>;
    publishOutput(body: Record<string, unknown>): Promise<void>;
  };
  /** StreamingState.registerPermission — resolves when mobile answers. */
  registerPermission(args: {
    questionId: string;
    labels: string[];
    optionIdByLabel: Record<string, string>;
  }): Promise<RequestPermissionResponse>;
}

export function createOnRequestPermission(
  deps: PermissionGateDeps,
): (request: RequestPermissionRequest) => Promise<RequestPermissionResponse> {
  return async (request) => {
    // CodeAgent platform-internals guard (MANAGED deploys only). Deny a tool
    // call (bash cat/ls, write, edit) that references an internal path BEFORE
    // auto-approve would allow it. Agent-agnostic — every ACP agent asks the
    // client here — so this covers claude/codex/gemini/cursor/opencode without
    // any Claude-specific settings. Not applied on a local session (there
    // ~/.codeam is the user's own config). See ./internal-paths.ts.
    let guardrailConfirm = false;
    if (!deps.isLocal()) {
      const denied = internalPathPermissionOutcome(request);
      if (denied) {
        log.warn(
          'acpRunner',
          'internal-path guard — denying tool call referencing a CodeAgent platform internal',
        );
        // HARD RULE: visible, never silent. Fire-and-forget (publishOutput
        // never throws) so the deny returns to the agent immediately.
        void deps.publisher.publishOutput({
          type: 'text',
          content: internalBlockNotice(request.toolCall),
          done: true,
        });
        return denied;
      }
      // Native ACP guardrails (MANAGED only): classify the tool call against
      // the session policy. `deny` blocks it here; `confirm` skips the AUTO
      // auto-approve below and routes to the interactive approve/deny prompt.
      const g = guardrailDecision(request, deps.getPolicy());
      if (g?.kind === 'deny') {
        log.warn('acpRunner', `guardrail [${g.category}] — denying tool call`);
        // HARD RULE: visible, never silent (same as the internals guard).
        void deps.publisher.publishOutput({
          type: 'text',
          content: guardrailBlockNotice(g, request.toolCall),
          done: true,
        });
        return g.outcome;
      }
      if (g?.kind === 'confirm') {
        guardrailConfirm = true;
        log.info('acpRunner', `guardrail [${g.category}] — requiring confirmation`);
      }
    }
    // AUTO mode (headless / codespace): no human at the phone to answer, so
    // auto-pick an "allow" option instead of stalling the turn forever. Pick
    // the broadest grant available (allow_always > allow_once). If the agent
    // somehow offers no allow option, fall through to the interactive flow.
    // A guardrail `confirm` overrides AUTO — the user must tap.
    if (deps.autoApprovePermissions && !guardrailConfirm) {
      const allow = pickAllowOption(request.options);
      if (allow) {
        log.info(
          'acpRunner',
          `AUTO mode — auto-approving permission (${allow.kind}) optionId=${allow.optionId}`,
        );
        return { outcome: { outcome: 'selected', optionId: allow.optionId } };
      }
      log.warn('acpRunner', 'AUTO mode — no allow option offered; falling back to interactive');
    }
    const { event, optionIdByLabel } = mapPermissionRequest(request);
    await deps.publisher.publishAwaitingAnswer(event);
    // Event-driven: register a Promise resolver in streaming
    // state. When mobile responds, the backend pushes a
    // `select_option` command via the CLI's existing SSE relay
    // (`/api/commands/pending/stream`); the `handleCommand` switch
    // routes it back here through `streaming.resolveSelection()`.
    // No polling.
    return deps.registerPermission({
      questionId: event.questionId,
      labels: event.options ?? [],
      optionIdByLabel,
    });
  };
}
