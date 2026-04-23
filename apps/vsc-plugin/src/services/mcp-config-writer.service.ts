import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { OutputChannel } from 'vscode';
import { IdeIntegrationService } from './ide-integration.service';

export interface McpEntry {
  id: string;
  server: { command: string; args: string[] };
  env: Record<string, string>;
}

export interface McpConfigureRequest {
  scope: string;
  mcps: McpEntry[];
  targetAgents?: string[];
}

export interface McpWriteResult {
  agent: string;
  file: string;
  status: 'written' | 'error';
  error?: string;
}

export interface ConfiguredMcpInfo {
  agent: string;
  mcpIds: string[];
  configFile: string;
}

interface AgentAdapter {
  agentName: string;
  serverKey: string;
  extensionIds: string[];
  globalConfigPath(): string;
  projectConfigPath(projectRoot: string): string;
}

const HOME = os.homedir();

const ADAPTERS: AgentAdapter[] = [
  {
    agentName: 'Cursor',
    serverKey: 'mcpServers',
    extensionIds: ['cursor.cursor'],
    globalConfigPath: () => path.join(HOME, '.cursor', 'mcp.json'),
    projectConfigPath: (root: string) => path.join(root, '.cursor', 'mcp.json'),
  },
  {
    agentName: 'Windsurf',
    serverKey: 'mcpServers',
    extensionIds: ['codeium.codeium', 'codeium.windsurf'],
    globalConfigPath: () => path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    projectConfigPath: (root: string) => path.join(root, '.windsurf', 'mcp_config.json'),
  },
  {
    agentName: 'VS Code',
    serverKey: 'servers',
    extensionIds: ['github.copilot-chat'],
    globalConfigPath: () => {
      if (process.platform === 'darwin') {
        return path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
      } else if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || HOME, 'Code', 'User', 'settings.json');
      }
      return path.join(HOME, '.config', 'Code', 'User', 'settings.json');
    },
    projectConfigPath: (root: string) => path.join(root, '.vscode', 'mcp.json'),
  },
  {
    agentName: 'Claude Desktop',
    serverKey: 'mcpServers',
    extensionIds: ['anthropic.claude-code', 'anthropics.claude', 'saoudrizwan.claude-dev'],
    globalConfigPath: () => {
      if (process.platform === 'darwin') {
        return path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      } else if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || HOME, 'Claude', 'claude_desktop_config.json');
      }
      return path.join(HOME, '.config', 'claude', 'claude_desktop_config.json');
    },
    projectConfigPath: (root: string) => path.join(root, '.claude', 'mcp.json'),
  },
  {
    agentName: 'Claude Code',
    serverKey: 'mcpServers',
    extensionIds: ['anthropic.claude-code'],
    globalConfigPath: () => path.join(HOME, '.claude.json'),
    projectConfigPath: (root: string) => path.join(root, '.mcp.json'),
  },
];

export class McpConfigWriterService {
  private static instance: McpConfigWriterService;
  private log: OutputChannel;

  private constructor(log: OutputChannel) {
    this.log = log;
  }

  static initialize(log: OutputChannel): McpConfigWriterService {
    McpConfigWriterService.instance = new McpConfigWriterService(log);
    return McpConfigWriterService.instance;
  }

  static getInstance(): McpConfigWriterService {
    if (!McpConfigWriterService.instance) {
      throw new Error('McpConfigWriterService not initialized');
    }
    return McpConfigWriterService.instance;
  }

  configure(request: McpConfigureRequest): McpWriteResult[] {
    const results: McpWriteResult[] = [];
    const installedIds = this.getInstalledExtensionIds();
    const projectRoot = this.getProjectRoot();

    for (const adapter of ADAPTERS) {
      const isInstalled = adapter.extensionIds.some((id) => installedIds.has(id));
      if (!isInstalled) { continue; }
      if (request.targetAgents && !request.targetAgents.includes(adapter.agentName)) { continue; }

      const configPath = request.scope === 'project' && projectRoot
        ? adapter.projectConfigPath(projectRoot)
        : adapter.globalConfigPath();

      try {
        this.writeConfigFile(configPath, adapter.serverKey, request.mcps);
        results.push({ agent: adapter.agentName, file: configPath, status: 'written' });
        this.log.appendLine(`MCP config written for ${adapter.agentName}: ${configPath}`);
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        results.push({ agent: adapter.agentName, file: configPath, status: 'error', error: errorMsg });
        this.log.appendLine(`MCP config error for ${adapter.agentName}: ${errorMsg}`);
      }
    }

    return results;
  }

  getConfiguredMcps(): ConfiguredMcpInfo[] {
    const results: ConfiguredMcpInfo[] = [];
    const installedIds = this.getInstalledExtensionIds();
    const projectRoot = this.getProjectRoot();

    for (const adapter of ADAPTERS) {
      const isInstalled = adapter.extensionIds.some((id) => installedIds.has(id));
      if (!isInstalled) { continue; }

      const paths = [adapter.globalConfigPath()];
      if (projectRoot) {
        const projPath = adapter.projectConfigPath(projectRoot);
        if (projPath !== paths[0]) { paths.push(projPath); }
      }

      for (const configPath of paths) {
        try {
          if (!fs.existsSync(configPath)) { continue; }

          const json = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          const serverKey = json.mcpServers ? 'mcpServers' : json.servers ? 'servers' : null;
          if (!serverKey) { continue; }

          const servers = json[serverKey];
          if (!servers || typeof servers !== 'object') { continue; }

          const ids = Object.keys(servers);
          if (ids.length > 0) {
            results.push({
              agent: adapter.agentName,
              mcpIds: ids,
              configFile: configPath,
            });
          }
        } catch (e) {
          this.log.appendLine(`Failed to read config for ${adapter.agentName} at ${configPath}: ${e}`);
        }
      }
    }

    return results;
  }

  private writeConfigFile(configPath: string, serverKey: string, mcps: McpEntry[]): void {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch {
        existing = {};
      }
    }

    const servers = (existing[serverKey] as Record<string, unknown>) || {};

    for (const mcp of mcps) {
      servers[mcp.id] = {
        command: mcp.server.command,
        args: mcp.server.args,
        env: mcp.env,
      };
    }

    existing[serverKey] = servers;
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');
  }

  private getInstalledExtensionIds(): Set<string> {
    const ids = new Set<string>();
    for (const ext of vscode.extensions.all) {
      ids.add(ext.id.toLowerCase());
    }
    return ids;
  }

  private getProjectRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
  }
}
