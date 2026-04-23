import * as vscode from 'vscode';
import { OutputChannel } from 'vscode';
import { SettingsService } from './settings.service';
import { TerminalAgentService } from './terminal-agent.service';

export interface DetectedAgent {
  id: string;
  name: string;
  extensionId: string;
  icon: string;
  installed: boolean;
  isTerminalAgent?: boolean;
  isLmAgent?: boolean;
}

interface KnownAgent {
  extensionId: string;
  name: string;
  icon: string;
}

const KNOWN_AGENTS: KnownAgent[] = [
  { extensionId: 'github.copilot-chat', name: 'GitHub Copilot Chat', icon: 'copilot' },
  { extensionId: 'github.copilot', name: 'GitHub Copilot', icon: 'copilot' },
  { extensionId: 'codeium.codeium', name: 'Codeium', icon: 'codeium' },
  { extensionId: 'codeium.windsurf', name: 'Windsurf', icon: 'codeium' },
  { extensionId: 'Codeium.windsurfPyright', name: 'Windsurf', icon: 'codeium' },
  { extensionId: 'anthropic.claude-code', name: 'Claude Code', icon: 'claude' },
  { extensionId: 'anthropics.claude', name: 'Claude', icon: 'claude' },
  { extensionId: 'saoudrizwan.claude-dev', name: 'Cline (Claude Dev)', icon: 'claude' },
  { extensionId: 'rooveterinaryinc.roo-cline', name: 'Roo Code (Cline)', icon: 'claude' },
  { extensionId: 'TabNine.tabnine-vscode', name: 'Tabnine', icon: 'tabnine' },
  { extensionId: 'AmazonWebServices.aws-toolkit-vscode', name: 'Amazon Q', icon: 'amazon-q' },
  { extensionId: 'amazonwebservices.amazon-q-vscode', name: 'Amazon Q', icon: 'amazon-q' },
  { extensionId: 'sourcegraph.cody-ai', name: 'Sourcegraph Cody', icon: 'cody' },
  { extensionId: 'continue.continue', name: 'Continue', icon: 'generic-ai' },
  { extensionId: 'supermaven.supermaven', name: 'Supermaven', icon: 'generic-ai' },
  { extensionId: 'cursor.cursor', name: 'Cursor', icon: 'cursor' },
  { extensionId: 'Google.geminicodeassist', name: 'Gemini Code Assist', icon: 'jetbrains-ai' },
  { extensionId: 'JetBrains.junie', name: 'Junie', icon: 'junie' },
  { extensionId: 'kilocode.kilo-code', name: 'Kilo Code', icon: 'generic-ai' },
  { extensionId: 'aider.aider', name: 'Aider', icon: 'generic-ai' },
];

// Special virtual agent for VS Code Chat (Copilot via vscode.lm API).
// Appears when GitHub Copilot is installed; its prompt is routed through
// vscode.lm.selectChatModels instead of requiring the user to open the chat.
const VSCODE_CHAT_AGENT_ID = '__vscode_lm__:copilot';

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

  private findExtensionCaseInsensitive(id: string): vscode.Extension<unknown> | undefined {
    // vscode.extensions.getExtension is case-sensitive. Official Copilot is
    // published as "GitHub.copilot" (capital G), so a lowercase match fails.
    const direct = vscode.extensions.getExtension(id);
    if (direct) { return direct; }
    const lower = id.toLowerCase();
    return vscode.extensions.all.find((e) => e.id.toLowerCase() === lower);
  }

  private async selectChatModelsWithTimeout(
    selector: vscode.LanguageModelChatSelector,
    timeoutMs: number,
  ): Promise<vscode.LanguageModelChat[] | null> {
    return Promise.race([
      vscode.lm.selectChatModels(selector),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  }

  async detectInstalledAgents(): Promise<DetectedAgent[]> {
    if (this.cachedAgents) { return this.cachedAgents; }

    const detected: DetectedAgent[] = [];

    // Whitelist-only detection (case-insensitive) — the previous heuristic
    // matched any extension whose name contained an AI keyword, but "ai"
    // pulled in "Monokai" and other false positives.
    for (const agent of KNOWN_AGENTS) {
      const ext = this.findExtensionCaseInsensitive(agent.extensionId);
      if (ext) {
        detected.push({
          id: agent.extensionId,
          name: agent.name,
          extensionId: agent.extensionId,
          icon: agent.icon,
          installed: true,
        });
        this.log.appendLine(`Detected known AI extension: ${agent.name} (${ext.id})`);
      }
    }

    // Virtual "VS Code Chat" agent via vscode.lm Language Model API.
    //
    // IMPORTANT quirk: selectChatModels() returns an empty array for
    // extensions that haven't been granted consent by the user — even if
    // models ARE registered by Copilot / Anthropic / etc. The consent
    // dialog only triggers on the first sendRequest() call, not on
    // selectChatModels(). If we gate registration on "models > 0", the
    // user can never grant consent because the agent never appears.
    //
    // Therefore: register the agent unconditionally when the LM API is
    // available (VS Code >= 1.90). On first prompt sent from mobile,
    // sendRequest() will surface the consent dialog in VS Code, and
    // subsequent calls will work normally.
    const lmApiAvailable = typeof vscode.lm?.selectChatModels === 'function';

    let detectedModelName: string | null = null;
    if (lmApiAvailable) {
      try {
        const models = await this.selectChatModelsWithTimeout({}, 2000);
        if (models && models.length > 0) {
          detectedModelName = models[0].name;
          const vendors = Array.from(new Set(models.map((m) => m.vendor))).join(', ');
          this.log.appendLine(`vscode.lm found ${models.length} model(s). Vendors: ${vendors}`);
          for (const m of models) {
            this.log.appendLine(`  · ${m.vendor}/${m.family}/${m.name}`);
          }
        } else {
          this.log.appendLine(
            'vscode.lm returned no models — likely needs consent. Registering anyway so the user can trigger consent via the mobile app.',
          );
        }
      } catch (e) {
        this.log.appendLine(`vscode.lm threw: ${e}`);
      }
    }

    const copilotExt =
      this.findExtensionCaseInsensitive('github.copilot-chat') ||
      this.findExtensionCaseInsensitive('github.copilot');

    if (lmApiAvailable) {
      const label = detectedModelName
        ? `VS Code Chat (${detectedModelName})`
        : 'VS Code Chat';
      detected.push({
        id: VSCODE_CHAT_AGENT_ID,
        name: label,
        extensionId: copilotExt?.id ?? 'vscode.chat',
        icon: 'copilot',
        installed: true,
        isLmAgent: true,
      });
      this.log.appendLine(
        `Registered VS Code Chat (model detected: ${detectedModelName ?? 'pending consent'})`,
      );
    } else {
      this.log.appendLine('vscode.lm API not available (VS Code < 1.90) — skipping VS Code Chat agent');
    }

    // Register terminal-based agents (Claude Code CLI) even if extension is not installed
    const terminalService = TerminalAgentService.getInstance();
    const claudeTerminal = terminalService.findClaudeCodeTerminal();
    const claudeAlreadyDetected = detected.some(
      (a) => a.id === 'anthropic.claude-code' || a.name === 'Claude Code',
    );
    if (claudeTerminal && !claudeAlreadyDetected) {
      detected.push({
        id: '__terminal__:claude_code',
        name: 'Claude Code',
        extensionId: 'anthropic.claude-code',
        icon: 'claude',
        installed: true,
        isTerminalAgent: true,
      });
      this.log.appendLine('Detected Claude Code via terminal tab');
    } else if (claudeAlreadyDetected) {
      const idx = detected.findIndex(
        (a) => a.id === 'anthropic.claude-code' || a.name === 'Claude Code',
      );
      if (idx >= 0) {
        detected[idx] = { ...detected[idx], isTerminalAgent: true };
        this.log.appendLine('Marked Claude Code as terminal-routable');
      }
    }

    this.cachedAgents = detected;
    this.log.appendLine(`Total detected agents: ${detected.length}`);
    return detected;
  }

  clearCache(): void {
    this.cachedAgents = null;
  }

  async sendPromptToAgent(prompt: string, agentId?: string): Promise<boolean> {
    this.log.appendLine(`[sendPrompt] prompt="${prompt.substring(0, 80)}..." | IDE=${vscode.env.appName}`);
    this.clearCache();

    // Route terminal-based agents (e.g. Claude Code CLI) to TerminalAgentService
    const agents = await this.detectInstalledAgents();
    const targetAgent = agentId
      ? agents.find((a) => a.id === agentId)
      : agents.find((a) => a.isTerminalAgent) || agents[0];

    if (targetAgent?.isTerminalAgent || agentId?.startsWith('__terminal__:')) {
      this.log.appendLine(`[sendPrompt] Routing to TerminalAgentService for ${targetAgent?.name || agentId}`);
      const terminalService = TerminalAgentService.getInstance();
      const sent = await terminalService.sendPromptToClaudeCode(prompt);
      if (sent) {
        this.notify(prompt);
        return true;
      }
      this.log.appendLine('[sendPrompt] TerminalAgentService failed, falling back to observer bridge');
    }

    // Submit prompt via the local capture server → observer script injects into Lexical editor.
    // This avoids all OS-level keyboard simulation and focus/toggle issues.
    const port = 47832;
    try {
      const result = await this.httpPost(`http://127.0.0.1:${port}/submit`, prompt);
      this.log.appendLine(`[sendPrompt] Submitted via observer bridge: ${result}`);
      this.notify(prompt);
      return true;
    } catch (e) {
      this.log.appendLine(`[sendPrompt] Observer bridge failed: ${e}`);
    }

    // Fallback: copy to clipboard and notify user
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showWarningMessage(
      'CodeAgent: Prompt copied to clipboard. Please paste into the AI chat and press Enter.',
    );
    this.notify(prompt);
    return false;
  }

  private httpPost(url: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const http = require('http') as typeof import('http');
      const parsed = new URL(url);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }


  private notify(prompt: string): void {
    if (SettingsService.getInstance().showNotifications) {
      vscode.window.showInformationMessage(`Prompt sent to AI: ${prompt.substring(0, 60)}...`);
    }
  }


}
