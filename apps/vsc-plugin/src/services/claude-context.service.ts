import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { OutputChannel } from 'vscode';
import { getContextWindow, getPricing } from '@codeagent/shared';

/**
 * Claude Code context + usage snapshot — mirrors the shape codeam-cli
 * returns from its `get_context` handler. Reads `~/.claude/projects/<encoded-cwd>/*.jsonl`
 * (the same session log Claude Code itself writes) so the mobile
 * client's quota/usage UI renders identically regardless of whether
 * the user is paired with the CLI or the VS Code extension.
 *
 * Keep field names and meanings in sync with
 * `apps/cli/src/services/history.service.ts`.
 */

export interface ClaudeContextSnapshot {
  used: number;
  total: number;
  percent: number;
  model: string | null;
  outputTokens: number;
  cacheReadTokens: number;
  monthlyCost: number;
  rateLimitReset?: string;
  quotaPercent?: number;
  error?: string;
}

export interface ClaudeModelInfo {
  id: string;
  label: string;
  description: string;
  family: string;
  vendor: string;
  isDefault?: boolean;
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/** Hardcoded list matching what Claude Code accepts via `/model`. Mirrors the CLI's list_models response. */
const CLAUDE_MODELS: ClaudeModelInfo[] = [
  { id: 'claude-opus-4-7',           label: 'Claude Opus 4.7',   description: 'Most capable', family: 'claude', vendor: 'anthropic' },
  { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6',   description: 'Top tier',     family: 'claude', vendor: 'anthropic' },
  { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6', description: 'Balanced',     family: 'claude', vendor: 'anthropic', isDefault: true },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',  description: 'Fastest',      family: 'claude', vendor: 'anthropic' },
];

export class ClaudeContextService {
  private static instance: ClaudeContextService;
  private rateLimitReset: string | null = null;
  private quotaPercent: number | null = null;
  private currentConversationId: string | null = null;

  private constructor(_log: OutputChannel) { void _log; }

  static initialize(log: OutputChannel): ClaudeContextService {
    ClaudeContextService.instance = new ClaudeContextService(log);
    return ClaudeContextService.instance;
  }

  static getInstance(): ClaudeContextService {
    if (!ClaudeContextService.instance) {
      throw new Error('ClaudeContextService not initialized');
    }
    return ClaudeContextService.instance;
  }

  listModels(): ClaudeModelInfo[] {
    return CLAUDE_MODELS;
  }

  /** Called by TerminalAgentService when it sees a rate-limit notice in claude's output. */
  setRateLimitReset(reset: string): void {
    this.rateLimitReset = reset;
  }

  setQuotaPercent(percent: number): void {
    this.quotaPercent = percent;
  }

  setCurrentConversationId(id: string | null): void {
    this.currentConversationId = id;
  }

  /**
   * Same shape as CLI's `get_context` response. Reads the most recently
   * touched `.jsonl` in the project dir, extracts the last assistant
   * message's `usage` block, and combines it with our tracked rate
   * limit + quota state and a monthly cost scan.
   */
  getContextSnapshot(): ClaudeContextSnapshot {
    const cwd = this.resolveCwd();
    const projectDir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));

    const usage = this.getCurrentUsage(projectDir);
    const monthlyCost = this.getMonthlyEstimatedCost(projectDir);

    const base = usage ?? {
      used: 0,
      total: 200_000,
      percent: 0,
      model: null,
      outputTokens: 0,
      cacheReadTokens: 0,
    };

    return {
      ...base,
      monthlyCost,
      ...(this.rateLimitReset ? { rateLimitReset: this.rateLimitReset } : {}),
      ...(this.quotaPercent !== null ? { quotaPercent: this.quotaPercent } : {}),
      ...(usage ? {} : { error: 'No usage data found' }),
    };
  }

  private resolveCwd(): string {
    return (
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()
    );
  }

  private getCurrentUsage(dir: string): Omit<ClaudeContextSnapshot, 'monthlyCost'> | null {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => {
        try {
          return { name: e.name, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs };
        } catch {
          return { name: e.name, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;

    const targetFile = this.currentConversationId
      ? `${this.currentConversationId}.jsonl`
      : files[0].name;

    if (!files.some((f) => f.name === targetFile)) return null;

    return this.extractUsageFromFile(path.join(dir, targetFile));
  }

  private extractUsageFromFile(filePath: string): Omit<ClaudeContextSnapshot, 'monthlyCost'> | null {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }

    let lastUsage: Record<string, number> | null = null;
    let lastModel: string | null = null;

    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record['type'] === 'assistant') {
          const msg = record['message'] as Record<string, unknown> | undefined;
          if (msg?.['model'] === '<synthetic>') continue;
          const usage = msg?.['usage'] as Record<string, number> | undefined;
          if (usage && (usage['input_tokens'] !== undefined || usage['prompt_tokens'] !== undefined)) {
            lastUsage = usage;
          }
          if (msg?.['model']) lastModel = msg['model'] as string;
        }
      } catch { /* skip malformed */ }
    }

    const total = getContextWindow(lastModel);

    if (!lastUsage) {
      if (!lastModel) return null;
      return { used: 0, total, percent: 0, model: lastModel, outputTokens: 0, cacheReadTokens: 0 };
    }

    const inputTokens = (lastUsage['input_tokens'] ?? lastUsage['prompt_tokens'] ?? 0)
      + (lastUsage['cache_read_input_tokens'] ?? 0)
      + (lastUsage['cache_creation_input_tokens'] ?? 0);
    const outputTokens = lastUsage['output_tokens'] ?? lastUsage['completion_tokens'] ?? 0;
    const percent = Math.min(100, Math.round((inputTokens / total) * 100));

    return {
      used: inputTokens,
      total,
      percent,
      model: lastModel,
      outputTokens,
      cacheReadTokens: lastUsage['cache_read_input_tokens'] ?? 0,
    };
  }

  private getMonthlyEstimatedCost(projectDir: string): number {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthStartIso = monthStart.toISOString();
    const monthStartMs = monthStart.getTime();
    let totalCost = 0;

    let files: string[];
    try {
      files = fs.readdirSync(projectDir)
        .filter((f) => f.endsWith('.jsonl'))
        .filter((f) => {
          try { return fs.statSync(path.join(projectDir, f)).mtimeMs >= monthStartMs; }
          catch { return false; }
        });
    } catch {
      return 0;
    }

    for (const file of files) {
      let raw: string;
      try { raw = fs.readFileSync(path.join(projectDir, file), 'utf8'); }
      catch { continue; }

      for (const line of raw.split('\n').filter(Boolean)) {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (record['type'] !== 'assistant') continue;
          const timestamp = record['timestamp'] as string | undefined;
          if (timestamp && timestamp < monthStartIso) continue;

          const msg = record['message'] as Record<string, unknown> | undefined;
          if (!msg || msg['model'] === '<synthetic>') continue;
          const model = (msg['model'] as string) || '';
          const usage = msg['usage'] as Record<string, number> | undefined;
          if (!usage) continue;

          const pricing = getPricing(model);
          const input = usage['input_tokens'] ?? 0;
          const output = usage['output_tokens'] ?? 0;
          const cacheRead = usage['cache_read_input_tokens'] ?? 0;
          const cacheWrite = usage['cache_creation_input_tokens'] ?? 0;

          totalCost += (input / 1_000_000) * pricing.input
            + (output / 1_000_000) * pricing.output
            + (cacheRead / 1_000_000) * pricing.cacheRead
            + (cacheWrite / 1_000_000) * pricing.cacheWrite;
        } catch { /* skip */ }
      }
    }

    return Math.round(totalCost * 100) / 100;
  }

  /** Detect rate-limit notice from Claude Code raw output. */
  tryDetectRateLimit(text: string): void {
    const match = text.match(/hit your limit.*resets\s+(.+?)(?:\s*\(|$)/i)
      ?? text.match(/rate.?limit.*resets\s+(.+?)(?:\s*\(|$)/i);
    if (match) this.setRateLimitReset(match[1].trim());
  }

  /** Detect weekly-quota percent from Claude's /usage output, e.g. "Weekly usage: 45%". */
  tryDetectQuota(text: string): void {
    const match = text.match(/weekly\s+usage\s*:?\s*(\d+)\s*%/i)
      ?? text.match(/(\d+)\s*%\s+of\s+weekly/i);
    if (match) this.setQuotaPercent(parseInt(match[1], 10));
  }
}
