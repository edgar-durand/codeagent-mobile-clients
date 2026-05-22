import { findExtension } from '../checks/extension';
import { whichBinary } from '../checks/binary';
import { dirExists, expandHome } from '../checks/config-dir';
import type { AgentDetector, DetectionContext, DetectionResult } from '../types';

/**
 * Detects OpenAI Codex. Three signals checked in order — first hit wins:
 *
 *   1. The official OpenAI VS Code extension (`openai.chatgpt`,
 *      marketplace name "Codex – OpenAI's coding agent").
 *   2. The `codex` binary on PATH.
 *   3. The `~/.codex/` config directory (created after a successful
 *      `codex login`).
 *
 * Every branch returns `isTerminalAgent: true`. The plugin has no
 * strategy to talk to Codex directly; the mobile app, on seeing the
 * flag, routes the user to `codeam-cli` which handles Codex end-to-end.
 */
export class CodexDetector implements AgentDetector {
  readonly id = 'codex';
  readonly name = 'Codex';
  readonly icon = 'codex';

  private static readonly CANDIDATE_EXTENSION_IDS = ['openai.chatgpt'];
  private static readonly BINARY_NAME = 'codex';
  private static readonly CONFIG_DIR = '~/.codex';

  async detect(ctx: DetectionContext): Promise<DetectionResult | null> {
    const extension = findExtension(CodexDetector.CANDIDATE_EXTENSION_IDS, ctx.extensions);
    if (extension) {
      return {
        installed: true,
        extensionId: extension.id,
        isTerminalAgent: true,
        via: 'extension',
      };
    }

    const binPath = await whichBinary(CodexDetector.BINARY_NAME);
    if (binPath) {
      ctx.log.appendLine(`[CodexDetector] binary at ${binPath}`);
      return {
        installed: true,
        extensionId: `__binary__:${CodexDetector.BINARY_NAME}`,
        isTerminalAgent: true,
        via: 'binary',
      };
    }

    if (await dirExists(expandHome(CodexDetector.CONFIG_DIR))) {
      ctx.log.appendLine(`[CodexDetector] config dir ${CodexDetector.CONFIG_DIR} present`);
      return {
        installed: true,
        extensionId: `__config__:${CodexDetector.BINARY_NAME}`,
        isTerminalAgent: true,
        via: 'config-dir',
      };
    }

    return null;
  }
}
