import { getAgent, type AgentId, type AgentMetadata, type AgentModel } from '@codeagent/shared';
import { buildClaudeLaunch } from '../../services/claude-resolver';
import { fetchClaudeQuota } from './quota';
import * as history from './history';
import type { ChangeModelInstruction, RuntimeStrategy } from '../strategy';

export class ClaudeRuntimeStrategy implements RuntimeStrategy {
  readonly id: AgentId = 'claude';
  readonly meta: AgentMetadata = getAgent('claude');

  async prepareLaunch(): Promise<{ cmd: string; args: string[]; env?: Record<string, string> }> {
    const launch = buildClaudeLaunch();
    if (!launch) throw new Error('claude binary not found in PATH');
    return { cmd: launch.cmd, args: launch.args };
  }

  resumeLaunchArgs(sessionId: string): string[] {
    return ['--resume', sessionId, '--dangerously-skip-permissions'];
  }

  resolveHistoryDir(cwd: string): string | null {
    return history.resolveHistoryDir(cwd);
  }

  parseHistoryFile(filePath: string) {
    return history.parseHistoryFile(filePath);
  }

  getCurrentUsage(historyDir: string) {
    return history.getCurrentUsage(historyDir);
  }

  async fetchWeeklyUsage() {
    return fetchClaudeQuota();
  }

  async listModels(): Promise<AgentModel[]> {
    // Mirror the Anthropic catalog. Context windows hardcoded — model registry
    // matches what the relay's listModels handler used to return inline.
    return [
      { id: 'claude-opus-4-7',           label: 'Claude Opus 4.7',   contextWindow: 200000 },
      { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6',   contextWindow: 200000 },
      { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6', contextWindow: 200000 },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',  contextWindow: 200000 },
    ];
  }

  changeModelInstruction(modelId: string): ChangeModelInstruction {
    return { type: 'pty', ptyInput: `/model ${modelId}\r` };
  }

  summarizeInstruction(mode: 'normal' | 'auto'): { ptyInput: string } {
    if (mode === 'normal') return { ptyInput: '/compact\r' };
    // Open question §10.3 — Claude's "AUTO" summarize syntax not yet confirmed.
    // Defaulting to /compact until Spec §10.3 is resolved.
    return { ptyInput: '/compact\r' };
  }
}
