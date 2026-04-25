import WebSocket from 'ws';

const API_BASE = process.env.CODEAM_API_URL ?? 'https://codeagent-mobile-api.vercel.app';
const WS_URL = API_BASE.replace('https://', 'wss://').replace('http://', 'ws://') + '/api/ws';
const HEARTBEAT_MS = 30_000;
const MAX_RECONNECT = 10;

export interface WsMessageHandler {
  onMessage(type: string, payload: Record<string, unknown>): void;
  onConnected(): void;
  onDisconnected(): void;
}

export class WebSocketService {
  private client: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private handlers: WsMessageHandler[] = [];
  private _connected = false;

  constructor(
    private readonly sessionId: string,
    private readonly pluginId: string,
  ) {}

  get connected(): boolean { return this._connected; }

  addHandler(h: WsMessageHandler): void { this.handlers.push(h); }

  connect(): void {
    this.disconnect();
    try {
      this.client = new WebSocket(WS_URL);

      this.client.on('open', () => {
        this._connected = true;
        this.reconnectAttempts = 0;
        this.client!.send(JSON.stringify({
          type: 'auth',
          payload: { sessionId: this.sessionId, pluginId: this.pluginId },
          timestamp: Date.now(),
        }));
        this.startHeartbeat();
        this.handlers.forEach(h => h.onConnected());
      });

      this.client.on('message', (raw: WebSocket.Data) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type: string; payload?: Record<string, unknown> };
          if (msg.type === 'pong' || msg.type === 'auth_success' || msg.type === 'auth_error') return;
          this.handlers.forEach(h => h.onMessage(msg.type, msg.payload ?? {}));
        } catch { /* ignore malformed */ }
      });

      this.client.on('close', () => {
        this._connected = false;
        this.stopHeartbeat();
        this.handlers.forEach(h => h.onDisconnected());
        if (this.reconnectAttempts < MAX_RECONNECT) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
          this.reconnectTimer = setTimeout(() => this.connect(), delay);
        }
      });

      this.client.on('error', () => { /* handled by close */ });
    } catch { /* ignore — handled by close */ }
  }

  send(type: string, payload: Record<string, unknown>): void {
    if (!this._connected || !this.client) return;
    this.client.send(JSON.stringify({ type, payload, timestamp: Date.now() }));
  }

  disconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.reconnectAttempts = 0;
    this.stopHeartbeat();
    this.client?.removeAllListeners();
    this.client?.close();
    this.client = null;
    this._connected = false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this._connected) this.client?.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
  }
}
