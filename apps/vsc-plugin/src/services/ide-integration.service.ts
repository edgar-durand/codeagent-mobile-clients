import * as vscode from 'vscode';
import { OutputChannel } from 'vscode';
import { SettingsService } from './settings.service';
import { AgentOutputMonitor } from './agent-output-monitor';
import { DETECTORS, runDetectors } from './agent-detection/registry';
import type { DetectedAgent } from './agent-detection/types';
import { Messages } from '../ui/messages';

export type { DetectedAgent };

/**
 * Thin orchestrator over the agent-detection registry. The plugin's
 * job for any agent — terminal (Claude / Codex / Cursor / CodeRabbit
 * / Aider) or in-IDE chat (Copilot, Windsurf, Tabnine, …) — is the
 * same: detect it in this IDE, report the list to the mobile, and
 * stay out of the way for runtime. Per-agent code lives in
 * `agent-detection/detectors/*.detector.ts`.
 */
export class IdeIntegrationService {
  private static instance: IdeIntegrationService;
  private log: OutputChannel;
  private cachedAgents: DetectedAgent[] | null = null;

  private constructor(log: OutputChannel) {
    this.log = log;
  }

  static initialize(log: OutputChannel): IdeIntegrationService {
    IdeIntegrationService.instance = new IdeIntegrationService(log);
    return IdeIntegrationService.instance;
  }

  static getInstance(): IdeIntegrationService {
    if (!IdeIntegrationService.instance) {
      throw new Error('IdeIntegrationService not initialized');
    }
    return IdeIntegrationService.instance;
  }

  async detectInstalledAgents(): Promise<DetectedAgent[]> {
    if (this.cachedAgents) return this.cachedAgents;
    const detected = await runDetectors(DETECTORS, {
      log: this.log,
      extensions: vscode.extensions.all,
    });
    this.cachedAgents = detected;
    this.log.appendLine(`Total detected agents: ${detected.length}`);
    return detected;
  }

  clearCache(): void {
    this.cachedAgents = null;
  }

  async sendPromptToAgent(prompt: string, _agentId?: string): Promise<boolean> {
    this.log.appendLine(`[sendPrompt] prompt="${prompt.substring(0, 80)}..." | IDE=${vscode.env.appName}`);
    this.clearCache();

    // Terminal agents (Claude / Codex / Cursor / CodeRabbit / Aider) are
    // owned by codeam-cli — the mobile dispatches their commands to the
    // CLI's pluginId directly. The only agents this service still drives
    // are JCEF / Lexical-based chat surfaces (Copilot Chat, Continue,
    // …), which the observer script picks up via AgentOutputMonitor's
    // pending-prompt queue.
    try {
      AgentOutputMonitor.getInstance().queuePrompt(prompt);
      this.log.appendLine('[sendPrompt] Queued via observer bridge');
      this.notify(prompt);
      return true;
    } catch (e) {
      this.log.appendLine(`[sendPrompt] Observer bridge failed: ${e}`);
    }

    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showWarningMessage(Messages.PromptCopiedToClipboard);
    this.notify(prompt);
    return false;
  }

  private notify(prompt: string): void {
    if (SettingsService.getInstance().showNotifications) {
      const preview = prompt.length > 60 ? `${prompt.substring(0, 60)}…` : prompt;
      vscode.window.showInformationMessage(Messages.PromptSent(preview));
    }
  }
}
