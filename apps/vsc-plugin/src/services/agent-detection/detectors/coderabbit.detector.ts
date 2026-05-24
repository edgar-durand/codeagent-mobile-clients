import { findExtension } from '../checks/extension';
import { whichBinary } from '../checks/binary';
import { dirExists, expandHome } from '../checks/config-dir';
import type { AgentDetector, DetectionContext, DetectionResult } from '../types';

/**
 * Detects CodeRabbit (CR's agentic PR-review CLI). Three signals
 * checked in order — first hit wins:
 *
 *   1. The official VS Code extension (`coderabbitai.coderabbit-vscode`).
 *   2. The `coderabbit` binary on PATH (installed via
 *      `curl -fsSL https://cli.coderabbit.ai/install.sh | sh`).
 *   3. The `~/.coderabbit/` config directory (created after a
 *      successful `coderabbit login`).
 *
 * Every branch returns `isTerminalAgent: true`. The plugin does not
 * drive CodeRabbit directly; codeam-cli's BatchAgentStrategy handles
 * runtime end-to-end.
 */
export class CodeRabbitDetector implements AgentDetector {
  readonly id = 'coderabbit';
  readonly name = 'CodeRabbit';
  readonly icon = 'coderabbit';

  private static readonly CANDIDATE_EXTENSION_IDS = ['coderabbitai.coderabbit-vscode'];
  private static readonly BINARY_NAME = 'coderabbit';
  private static readonly CONFIG_DIR = '~/.coderabbit';

  async detect(ctx: DetectionContext): Promise<DetectionResult | null> {
    const extension = findExtension(CodeRabbitDetector.CANDIDATE_EXTENSION_IDS, ctx.extensions);
    if (extension) {
      return {
        installed: true,
        extensionId: extension.id,
        isTerminalAgent: true,
        via: 'extension',
      };
    }

    const binPath = await whichBinary(CodeRabbitDetector.BINARY_NAME);
    if (binPath) {
      ctx.log.appendLine(`[CodeRabbitDetector] binary at ${binPath}`);
      return {
        installed: true,
        extensionId: `__binary__:${CodeRabbitDetector.BINARY_NAME}`,
        isTerminalAgent: true,
        via: 'binary',
      };
    }

    if (await dirExists(expandHome(CodeRabbitDetector.CONFIG_DIR))) {
      ctx.log.appendLine(`[CodeRabbitDetector] config dir ${CodeRabbitDetector.CONFIG_DIR} present`);
      return {
        installed: true,
        extensionId: `__config__:${CodeRabbitDetector.BINARY_NAME}`,
        isTerminalAgent: true,
        via: 'config-dir',
      };
    }

    return null;
  }
}
