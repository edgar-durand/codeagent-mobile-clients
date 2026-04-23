import * as vscode from 'vscode';
import { OutputChannel } from 'vscode';
import { SettingsService } from './settings.service';
import { CommandRelayService } from './command-relay.service';

export interface ChatHistoryMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  timestamp: number;
}

interface ChatHistorySession {
  id: string;
  summary: string;
  timestamp: number;
  messages: ChatHistoryMessage[];
}

const STORAGE_KEY = 'codeagent-mobile.chatHistory';
const MAX_SESSIONS = 50;
const NEW_SESSION_GAP_MS = 30 * 60 * 1000; // 30 min of inactivity starts a new session

/**
 * Tracks per-pairing chat history for the VS Code Chat (vscode.lm) agent.
 * Unlike Claude Code (where the CLI parses ~/.claude/projects/*.jsonl), the
 * LM API does not expose past conversations, so we record them ourselves
 * whenever a prompt is sent and a response is streamed back.
 *
 * History survives extension restarts via VS Code's globalState, and is
 * pushed to the CodeAgent API after each new turn so the mobile app's
 * "Sessions" screen shows the same conversations listed in the native
 * VS Code Chat panel.
 */
export class ChatHistoryService {
  private static instance: ChatHistoryService;
  private log: OutputChannel;
  private context: vscode.ExtensionContext;
  private sessions: ChatHistorySession[] = [];
  private currentSessionId: string | null = null;
  private lastActivityAt = 0;

  private constructor(context: vscode.ExtensionContext, log: OutputChannel) {
    this.context = context;
    this.log = log;
    this.sessions = context.globalState.get<ChatHistorySession[]>(STORAGE_KEY) ?? [];
  }

  static initialize(context: vscode.ExtensionContext, log: OutputChannel): ChatHistoryService {
    ChatHistoryService.instance = new ChatHistoryService(context, log);
    return ChatHistoryService.instance;
  }

  static getInstance(): ChatHistoryService {
    if (!ChatHistoryService.instance) {
      throw new Error('ChatHistoryService not initialized');
    }
    return ChatHistoryService.instance;
  }

  /** Begin a new session, e.g. when the user starts a fresh topic. */
  startNewSession(firstPrompt: string): string {
    const id = this.generateId();
    const summary = firstPrompt.trim().slice(0, 120);
    const session: ChatHistorySession = {
      id,
      summary: summary.length > 0 ? summary : 'New chat',
      timestamp: Date.now(),
      messages: [],
    };
    this.sessions.unshift(session);
    this.currentSessionId = id;
    this.lastActivityAt = Date.now();
    this.trim();
    return id;
  }

  /** Append a user prompt. Starts a new session if idle too long. */
  addUserMessage(text: string): ChatHistorySession {
    const now = Date.now();
    const idle = now - this.lastActivityAt > NEW_SESSION_GAP_MS;

    if (!this.currentSessionId || idle) {
      this.startNewSession(text);
    }
    const session = this.requireCurrent();
    session.messages.push({
      id: this.generateId(),
      role: 'user',
      text,
      timestamp: now,
    });
    // Update summary if this is the first user turn.
    if (session.messages.filter((m) => m.role === 'user').length === 1) {
      session.summary = text.trim().slice(0, 120) || session.summary;
    }
    session.timestamp = now;
    this.lastActivityAt = now;
    this.persist();
    return session;
  }

  /** Append an agent response. Must be called after addUserMessage. */
  addAgentMessage(text: string): ChatHistorySession | null {
    const session = this.getCurrent();
    if (!session) return null;
    session.messages.push({
      id: this.generateId(),
      role: 'agent',
      text,
      timestamp: Date.now(),
    });
    session.timestamp = Date.now();
    this.lastActivityAt = session.timestamp;
    this.persist();
    return session;
  }

  getCurrent(): ChatHistorySession | null {
    if (!this.currentSessionId) return null;
    return this.sessions.find((s) => s.id === this.currentSessionId) ?? null;
  }

  getCurrentId(): string | null {
    return this.currentSessionId;
  }

  setCurrentId(id: string | null): void {
    if (id === null) {
      this.currentSessionId = null;
      this.lastActivityAt = 0;
      return;
    }
    if (this.sessions.some((s) => s.id === id)) {
      this.currentSessionId = id;
      this.lastActivityAt = Date.now();
    }
  }

  getSession(id: string): ChatHistorySession | null {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  /** All sessions in the shape expected by the API and mobile app. */
  listSessions(): Array<{ id: string; summary: string; timestamp: number }> {
    return this.sessions.map((s) => ({
      id: s.id,
      summary: s.summary,
      timestamp: s.timestamp,
    }));
  }

  clear(): void {
    this.sessions = [];
    this.currentSessionId = null;
    this.lastActivityAt = 0;
    this.persist();
  }

  /** Push the sessions list to the CodeAgent API so mobile sees it. */
  async pushSessions(): Promise<void> {
    const settings = SettingsService.getInstance();
    const pluginId = settings.ensurePluginId();
    const list = this.listSessions();
    try {
      const result = await CommandRelayService.getInstance().postJson(
        `${settings.apiBaseUrl}/api/sessions/claude-sessions`,
        { pluginId, sessions: list },
      );
      this.log.appendLine(`[chat-history] pushSessions: ${list.length} session(s) → ${JSON.stringify(result)}`);
    } catch (e) {
      this.log.appendLine(`[chat-history] pushSessions error: ${e}`);
    }
  }

  /** Push the full message list of a specific session (for resume). */
  async pushConversation(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      this.log.appendLine(`[chat-history] pushConversation: session ${sessionId} not found`);
      return;
    }
    const settings = SettingsService.getInstance();
    const pluginId = settings.ensurePluginId();
    try {
      const result = await CommandRelayService.getInstance().postJson(
        `${settings.apiBaseUrl}/api/sessions/claude-conversation`,
        {
          pluginId,
          sessionId,
          messages: session.messages.map((m) => ({
            id: m.id,
            role: m.role,
            text: m.text,
            timestamp: m.timestamp,
          })),
        },
      );
      this.log.appendLine(`[chat-history] pushConversation: ${session.messages.length} msg(s) → ${JSON.stringify(result)}`);
    } catch (e) {
      this.log.appendLine(`[chat-history] pushConversation error: ${e}`);
    }
  }

  private requireCurrent(): ChatHistorySession {
    const s = this.getCurrent();
    if (!s) throw new Error('No current chat session');
    return s;
  }

  private trim(): void {
    if (this.sessions.length > MAX_SESSIONS) {
      this.sessions = this.sessions.slice(0, MAX_SESSIONS);
    }
  }

  private persist(): void {
    this.context.globalState.update(STORAGE_KEY, this.sessions);
  }

  private generateId(): string {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${Date.now().toString(36)}-${rand}`;
  }
}
