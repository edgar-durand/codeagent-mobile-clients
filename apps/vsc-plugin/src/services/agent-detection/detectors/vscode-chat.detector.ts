import * as vscode from 'vscode';
import { findExtension } from '../checks/extension';
import type { AgentDetector, DetectionContext, DetectionResult } from '../types';

/**
 * Virtual "VS Code Chat" agent backed by the `vscode.lm` Language
 * Model API (Copilot via vscode.lm). Distinct from the
 * `ExtensionOnlyDetector('github.copilot-chat')` — that one matches
 * the Chat extension as a JCEF chat target the observer bridge can
 * inject into, while this one represents the headless
 * `selectChatModels()` route the mobile picker hits with `agentId =
 * __vscode_lm__:copilot`.
 *
 * Detection quirk: `selectChatModels()` returns `[]` when the user
 * has not yet granted consent — but consent only triggers on
 * `sendRequest()`. We therefore register the agent unconditionally
 * when the LM API is available (VS Code >= 1.90) and let the first
 * mobile prompt surface the consent dialog. Model name probing is
 * best-effort: a 2 s race so cold startup isn't blocked by Copilot's
 * lazy init.
 */
export const VSCODE_CHAT_AGENT_ID = '__vscode_lm__:copilot';

const COPILOT_EXTENSION_IDS = ['github.copilot-chat', 'github.copilot'];
const MODEL_PROBE_TIMEOUT_MS = 2000;

async function probeModelName(): Promise<string | null> {
  if (typeof vscode.lm?.selectChatModels !== 'function') return null;
  const models = await Promise.race<vscode.LanguageModelChat[] | null>([
    vscode.lm.selectChatModels({}),
    new Promise((resolve) => setTimeout(() => resolve(null), MODEL_PROBE_TIMEOUT_MS)),
  ]);
  return models && models.length > 0 ? models[0].name : null;
}

export class VsCodeChatDetector implements AgentDetector {
  readonly id = VSCODE_CHAT_AGENT_ID;
  readonly name = 'VS Code Chat';
  readonly icon = 'copilot';

  async detect(ctx: DetectionContext): Promise<DetectionResult | null> {
    if (typeof vscode.lm?.selectChatModels !== 'function') {
      ctx.log.appendLine('vscode.lm API not available (VS Code < 1.90) — skipping VS Code Chat agent');
      return null;
    }

    let modelName: string | null = null;
    try {
      modelName = await probeModelName();
    } catch (e) {
      ctx.log.appendLine(`vscode.lm threw: ${e}`);
    }

    const copilotExt = findExtension(COPILOT_EXTENSION_IDS, ctx.extensions);
    const extensionId = copilotExt?.id ?? 'vscode.chat';
    ctx.log.appendLine(
      `Registered VS Code Chat (model detected: ${modelName ?? 'pending consent'})`,
    );

    return {
      installed: true,
      extensionId,
      via: 'extension',
      isLmAgent: true,
      // Override the detector's default name so the picker shows the
      // resolved model name (e.g. "VS Code Chat (Claude Sonnet 4.6)").
      displayNameOverride: modelName ? `VS Code Chat (${modelName})` : 'VS Code Chat',
      // Override the agent id so the wire id matches what the mobile
      // picker dispatches against (`__vscode_lm__:copilot`), not the
      // detector's `id` which would otherwise be the same string but
      // we want this contract explicit.
      idOverride: VSCODE_CHAT_AGENT_ID,
    };
  }
}
