import { ClaudeCodeDetector } from './detectors/claude-code.detector';
import { CodexDetector } from './detectors/codex.detector';
import { CursorDetector } from './detectors/cursor.detector';
import { CodeRabbitDetector } from './detectors/coderabbit.detector';
import { AiderDetector } from './detectors/aider.detector';
import { ExtensionOnlyDetector } from './detectors/extension-only.detector';
import { VsCodeChatDetector } from './detectors/vscode-chat.detector';
import type { AgentDetector, DetectionContext, DetectionResult, DetectedAgent } from './types';

/**
 * Canonical detector list. Every IDE-side agent visible to the mobile
 * picker is enumerated here — no inline detection logic anywhere
 * else in the plugin. Terminal agents own their own classes (per
 * `feedback_per_agent_parser_encapsulation`); long-tail
 * extension-id-only matches use the `ExtensionOnlyDetector` factory.
 */
export const DETECTORS: readonly AgentDetector[] = [
  // ─── Terminal agents (owned end-to-end by codeam-cli) ────────────
  new ClaudeCodeDetector(),
  new CodexDetector(),
  new CursorDetector(),
  new CodeRabbitDetector(),
  new AiderDetector(),

  // ─── VS Code-side chat agents (observer bridge / lm API) ─────────
  new VsCodeChatDetector(),
  new ExtensionOnlyDetector({
    id: 'github.copilot-chat',
    name: 'GitHub Copilot Chat',
    icon: 'copilot',
    extensionIds: ['github.copilot-chat'],
  }),
  new ExtensionOnlyDetector({
    id: 'github.copilot',
    name: 'GitHub Copilot',
    icon: 'copilot',
    extensionIds: ['github.copilot'],
  }),
  new ExtensionOnlyDetector({
    id: 'codeium',
    name: 'Codeium',
    icon: 'codeium',
    extensionIds: ['codeium.codeium'],
  }),
  new ExtensionOnlyDetector({
    id: 'windsurf',
    name: 'Windsurf',
    icon: 'codeium',
    extensionIds: ['codeium.windsurf', 'Codeium.windsurfPyright'],
  }),
  new ExtensionOnlyDetector({
    id: 'cline',
    name: 'Cline (Claude Dev)',
    icon: 'claude',
    extensionIds: ['saoudrizwan.claude-dev'],
  }),
  new ExtensionOnlyDetector({
    id: 'roo-cline',
    name: 'Roo Code (Cline)',
    icon: 'claude',
    extensionIds: ['rooveterinaryinc.roo-cline'],
  }),
  new ExtensionOnlyDetector({
    id: 'tabnine',
    name: 'Tabnine',
    icon: 'tabnine',
    extensionIds: ['TabNine.tabnine-vscode'],
  }),
  new ExtensionOnlyDetector({
    id: 'amazon-q',
    name: 'Amazon Q',
    icon: 'amazon-q',
    extensionIds: [
      'AmazonWebServices.aws-toolkit-vscode',
      'amazonwebservices.amazon-q-vscode',
    ],
  }),
  new ExtensionOnlyDetector({
    id: 'cody',
    name: 'Sourcegraph Cody',
    icon: 'cody',
    extensionIds: ['sourcegraph.cody-ai'],
  }),
  new ExtensionOnlyDetector({
    id: 'continue',
    name: 'Continue',
    icon: 'generic-ai',
    extensionIds: ['continue.continue'],
  }),
  new ExtensionOnlyDetector({
    id: 'supermaven',
    name: 'Supermaven',
    icon: 'generic-ai',
    extensionIds: ['supermaven.supermaven'],
  }),
  new ExtensionOnlyDetector({
    id: 'cursor-ide',
    name: 'Cursor',
    icon: 'cursor',
    extensionIds: ['cursor.cursor'],
  }),
  new ExtensionOnlyDetector({
    id: 'gemini',
    name: 'Gemini Code Assist',
    icon: 'jetbrains-ai',
    extensionIds: ['Google.geminicodeassist'],
  }),
  new ExtensionOnlyDetector({
    id: 'junie',
    name: 'Junie',
    icon: 'junie',
    extensionIds: ['JetBrains.junie'],
  }),
  new ExtensionOnlyDetector({
    id: 'kilo-code',
    name: 'Kilo Code',
    icon: 'generic-ai',
    extensionIds: ['kilocode.kilo-code'],
  }),
  new ExtensionOnlyDetector({
    id: 'aider-vscode',
    name: 'Aider',
    icon: 'generic-ai',
    extensionIds: ['aider.aider'],
  }),
];

export function toDetectedAgent(d: AgentDetector, r: DetectionResult): DetectedAgent {
  const id = r.idOverride
    ?? (r.via === 'extension' ? r.extensionId : `__terminal__:${d.id}`);
  return {
    id,
    name: r.displayNameOverride ?? d.name,
    extensionId: r.extensionId,
    icon: d.icon,
    installed: true,
    isTerminalAgent: r.isTerminalAgent,
    isLmAgent: r.isLmAgent,
  };
}

export async function runDetectors(
  detectors: readonly AgentDetector[],
  ctx: DetectionContext,
): Promise<DetectedAgent[]> {
  const results = await Promise.all(
    detectors.map(async (d) => {
      try {
        const r = await d.detect(ctx);
        return r ? toDetectedAgent(d, r) : null;
      } catch (e) {
        ctx.log.appendLine(`[agent-detection] ${d.id} threw: ${String(e)}`);
        return null;
      }
    }),
  );
  return results.filter((x): x is DetectedAgent => x !== null);
}
