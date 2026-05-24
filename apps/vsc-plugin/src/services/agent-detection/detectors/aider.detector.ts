import { whichBinary } from '../checks/binary';
import { fileExists, expandHome } from '../checks/config-dir';
import type { AgentDetector, DetectionContext, DetectionResult } from '../types';

/**
 * Detects Aider (paul-gauthier/aider — interactive coding agent that
 * pairs an LLM with the user's git repo). Two signals, first hit wins:
 *
 *   1. The `aider` binary on PATH (typical `pip install aider-chat` /
 *      pipx install).
 *   2. `~/.aider.conf.yml` (a single YAML file, not a directory) —
 *      Aider's own config home which is also where its API-key
 *      escape hatch is documented.
 *
 * No VS Code extension probe — Aider has no official marketplace
 * extension. Every branch returns `isTerminalAgent: true` so the
 * mobile dispatches runtime commands to codeam-cli's pluginId.
 */
export class AiderDetector implements AgentDetector {
  readonly id = 'aider';
  readonly name = 'Aider';
  readonly icon = 'aider';

  private static readonly BINARY_NAME = 'aider';
  // Aider config-file locations, both documented in Aider's README and
  // cross-platform: `~/.aider.conf.yml` is the historical default
  // (resolves to `C:\Users\<user>\.aider.conf.yml` on Windows),
  // `~/.config/aider/aider.conf.yml` is the XDG variant Linux users
  // tend to prefer.
  private static readonly CONFIG_FILES = ['~/.aider.conf.yml', '~/.config/aider/aider.conf.yml'];

  async detect(ctx: DetectionContext): Promise<DetectionResult | null> {
    const binPath = await whichBinary(AiderDetector.BINARY_NAME);
    if (binPath) {
      ctx.log.appendLine(`[AiderDetector] binary at ${binPath}`);
      return {
        installed: true,
        extensionId: `__binary__:${AiderDetector.BINARY_NAME}`,
        isTerminalAgent: true,
        via: 'binary',
      };
    }

    for (const file of AiderDetector.CONFIG_FILES) {
      if (await fileExists(expandHome(file))) {
        ctx.log.appendLine(`[AiderDetector] config file ${file} present`);
        return {
          installed: true,
          extensionId: `__config__:${AiderDetector.BINARY_NAME}`,
          isTerminalAgent: true,
          via: 'config-dir',
        };
      }
    }

    return null;
  }
}
