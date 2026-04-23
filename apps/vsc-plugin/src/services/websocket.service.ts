import WebSocket from 'ws';
import { SettingsService } from './settings.service';
import { OutputChannel } from 'vscode';

export interface WebSocketListener {
  onConnected(): void;
  onDisconnected(reason: string): void;
  onMessage(type: string, payload: Record<string, unknown>): void;
  onError(error: string): void;
}

export class WebSocketService {
  private static instance: WebSocketService;
  private client: WebSocket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private listeners: WebSocketListener[] = [];
  private log: OutputChannel;
  private _isConnected = false;
  private currentSessionId: string | null = null;
  private currentToken: string | null = null;

  private constructor(log: OutputChannel) {
    this.log = log;
  }

  static initialize(log: OutputChannel): WebSocketService {
    WebSocketService.instance = new WebSocketService(log);
    return WebSocketService.instance;
  }

  static getInstance(): WebSocketService {
    if (!WebSocketService.instance) {
      throw new Error('WebSocketService not initialized');
    }
    return WebSocketService.instance;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  addListener(listener: WebSocketListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: WebSocketListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  connect(sessionId: string, token: string): void {
    const settings = SettingsService.getInstance();
    const wsUrl = settings.apiBaseUrl
      .replace('https://', 'wss://')
      .replace('http://', 'ws://') + '/api/ws';

    this.disconnect();
    this.currentSessionId = sessionId;
    this.currentToken = token;

    try {
      this.client = new WebSocket(wsUrl);

      this.client.on('open', () => {
        this.log.appendLine('WebSocket connected');
        this._isConnected = true;
        this.reconnectAttempts = 0;

        const authMessage = JSON.stringify({
          type: 'auth',
          payload: {
            token,
            pluginId: settings.ensurePluginId(),
            sessionId,
          },
          timestamp: Date.now(),
        });
        this.client?.send(authMessage);
        this.startHeartbeat();
        this.listeners.forEach((l) => l.onConnected());
      });

      this.client.on('message', (data: WebSocket.Data) => {
        try {
          const json = JSON.parse(data.toString());
          const type: string = json.type;
          const payload: Record<string, unknown> = json.payload || {};

          switch (type) {
            case 'pong':
              break;
            case 'auth_success':
              this.log.appendLine('WebSocket authenticated');
              break;
            case 'auth_error': {
              const error = (payload.message as string) || 'Authentication failed';
              this.log.appendLine(`WebSocket auth error: ${error}`);
              this.listeners.forEach((l) => l.onError(error));
              break;
            }
            default:
              this.listeners.forEach((l) => l.onMessage(type, payload));
          }
        } catch (e) {
          this.log.appendLine(`Error parsing WebSocket message: ${e}`);
        }
      });

      this.client.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString() || 'Connection closed';
        this.log.appendLine(`WebSocket closed: ${code} - ${reasonStr}`);
        this._isConnected = false;
        this.stopHeartbeat();
        this.listeners.forEach((l) => l.onDisconnected(reasonStr));

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect();
        }
      });

      this.client.on('error', (err: Error) => {
        this.log.appendLine(`WebSocket error: ${err.message}`);
        this.listeners.forEach((l) => l.onError(err.message));
      });
    } catch (e) {
      this.log.appendLine(`Failed to create WebSocket connection: ${e}`);
    }
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.client) {
      this.client.removeAllListeners();
      this.client.close();
      this.client = null;
    }
    this._isConnected = false;
  }

  sendMessage(type: string, payload: Record<string, unknown>): void {
    if (!this._isConnected || !this.client) {
      this.log.appendLine('Cannot send message: not connected');
      return;
    }
    const message = JSON.stringify({
      type,
      payload,
      timestamp: Date.now(),
      messageId: generateMessageId(),
    });
    this.client.send(message);
  }

  sendAgentEvent(eventType: string, sessionId: string, data: Record<string, unknown>): void {
    this.sendMessage('agent_event', {
      type: eventType,
      sessionId,
      data,
      timestamp: Date.now(),
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = SettingsService.getInstance().heartbeatIntervalMs;
    this.heartbeatInterval = setInterval(() => {
      if (this._isConnected && this.client) {
        this.client.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      }
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.log.appendLine(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

    setTimeout(() => {
      if (!this._isConnected && this.currentSessionId && this.currentToken) {
        this.connect(this.currentSessionId, this.currentToken);
      }
    }, delay);
  }
}

function generateMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
