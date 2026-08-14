/**
 * `@coderabbit` one-shot review mentions (Agent Squad P2-1).
 *
 * **Why this is NOT a swap.** Every other squad member is an ACP agent the
 * session can swap onto (`routeToAgent` → `performAgentSwitch`). CodeRabbit
 * cannot be: it has no ACP adapter (`adapters.ts` REGISTRY), and
 * `CoderabbitRuntimeStrategy` is a `BatchAgentStrategy` (`mode: 'batch'`) —
 * one `coderabbit review` spawn, parse stdout, exit. There is no session to
 * take over and no prompt input to drive.
 *
 * So a `@coderabbit` mention runs the EXISTING batch review machinery (the same
 * `configureCoderabbit({action:'review'})` path the `coderabbit_configure`
 * relay command uses) as a synthetic turn INSIDE the current session. The
 * resident agent is never stopped, never swapped, and never sees the turn —
 * which is exactly the user-visible outcome the spec asks for, with no wedge
 * risk.
 *
 * Credential: reuse the vaulted CodeRabbit credential (`provision`) when the
 * local CLI isn't logged in, so a mention works on a fresh box the user linked
 * CodeRabbit from somewhere else. No vaulted credential → an honest refusal.
 */
import type { AgentId } from '@codeam/shared';
import { log } from '../../services/logger';
import { configureCoderabbit, type CoderabbitConfigureResult } from '../coderabbit/configure';
import { CoderabbitRuntimeStrategy } from '../coderabbit/runtime';
import { createOsStrategy } from '../../os';
import type { BatchInvocationInput, BatchInvocationOutput } from '../strategy';

export const CODERABBIT_AGENT_ID: AgentId = 'coderabbit';

/** Shown when the user is not linked. Names the exact screen, like every other
 *  credential refusal in the switch machinery. */
export const CODERABBIT_NOT_LINKED_MESSAGE = 'Link CodeRabbit in Profile › Your Squad first.';

/**
 * CodeRabbit's CLI takes NO free-form prompt — `coderabbit review` reviews the
 * working tree's current changes, scoped by `-t/--base/--dir` only. When the
 * user typed something beyond the mention we say so instead of silently
 * dropping their words.
 */
export const CODERABBIT_NO_CUSTOM_INSTRUCTIONS_NOTICE =
  "CodeRabbit reviews your current changes — custom instructions aren't supported yet.";

/**
 * True when the user's message carries instructions beyond the bare
 * `@coderabbit` mention. The mention itself may or may not survive into the
 * prompt text (mobile lifts it into `payload.agentId`), so strip any
 * `@coderabbit` token first and look at what's left.
 */
export function hasCustomInstructions(prompt: string): boolean {
  return prompt.replace(/@coderabbit\b/gi, '').trim().length > 0;
}

/** Compose what the review turn publishes: the notice (only when the user gave
 *  instructions we can't honour) above CodeRabbit's own markdown. */
export function composeReviewOutput(markdown: string, custom: boolean): string {
  const body =
    markdown.trim().length > 0 ? markdown.trim() : 'CodeRabbit found no issues to report.';
  return custom ? `${CODERABBIT_NO_CUSTOM_INSTRUCTIONS_NOTICE}\n\n${body}` : body;
}

export interface CoderabbitMentionDeps {
  /** The reviewer orchestration. Injected so tests never spawn the real CLI. */
  configure?: typeof configureCoderabbit;
  /** The batch review spawn. Defaults to the real `CoderabbitRuntimeStrategy`. */
  runReview?: (input: BatchInvocationInput) => Promise<BatchInvocationOutput>;
  /** Fetch the caller's vaulted CodeRabbit credential from the backend. */
  fetchCredential?: () => Promise<{ method: 'api_key' | 'oauth'; credential: string } | null>;
}

export type CoderabbitMentionResult = { ok: true; markdown: string } | { ok: false; error: string };

function defaultRunReview(input: BatchInvocationInput): Promise<BatchInvocationOutput> {
  return new CoderabbitRuntimeStrategy(createOsStrategy()).runOneShot(input);
}

/**
 * Run ONE CodeRabbit review for a mention. Never throws — every failure comes
 * back as an honest `{ok:false, error}` the caller surfaces verbatim, so the
 * session is unaffected either way.
 *
 * Takes NO prompt: `coderabbit review` has no free-form input, which is exactly
 * what {@link CODERABBIT_NO_CUSTOM_INSTRUCTIONS_NOTICE} tells the user.
 */
export async function runCoderabbitMentionReview(
  deps: CoderabbitMentionDeps = {},
): Promise<CoderabbitMentionResult> {
  const configure = deps.configure ?? configureCoderabbit;
  const runReview = deps.runReview ?? defaultRunReview;

  try {
    // 1. Is this box already logged in? (Installs nothing — `status` is cheap.)
    const status = await configure({ action: 'status' });
    if (!status.loggedIn) {
      // 2. Not logged in → restore the user's VAULTED credential. This is what
      //    makes a mention work on a fresh codespace/box the user linked
      //    CodeRabbit from a different machine.
      const cred = deps.fetchCredential ? await deps.fetchCredential() : null;
      if (!cred) return { ok: false, error: CODERABBIT_NOT_LINKED_MESSAGE };
      const provisioned = await configure({
        action: 'provision',
        provisionCredential: cred,
      });
      if (!provisioned.loggedIn) {
        return { ok: false, error: provisioned.error ?? CODERABBIT_NOT_LINKED_MESSAGE };
      }
    }
    // 3. Review the working tree's current changes.
    const result: CoderabbitConfigureResult = await configure({ action: 'review' }, { runReview });
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, markdown: result.review?.markdown ?? '' };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'CodeRabbit review failed',
    };
  }
}

/** Log line shared by the handler's success/failure paths. */
export function logMentionOutcome(result: CoderabbitMentionResult): void {
  if (result.ok) {
    log.info('acpRunner', `squad: coderabbit review completed (${result.markdown.length} chars)`);
  } else {
    log.warn('acpRunner', `squad: coderabbit review failed: ${result.error}`);
  }
}
