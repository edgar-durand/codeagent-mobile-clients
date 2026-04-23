import { OutputChannel } from 'vscode';
import { WebSocketService, WebSocketListener } from './websocket.service';

export interface AgentState {
  status: string;
  currentTaskId: string | null;
  currentTaskDescription: string | null;
  progress: number;
  model: string;
}

export class AgentBridgeService implements WebSocketListener {
  private static instance: AgentBridgeService;
  private log: OutputChannel;

  agentState: AgentState = {
    status: 'idle',
    currentTaskId: null,
    currentTaskDescription: null,
    progress: 0,
    model: 'unknown',
  };

  private constructor(log: OutputChannel) {
    this.log = log;
    WebSocketService.getInstance().addListener(this);
  }

  static initialize(log: OutputChannel): AgentBridgeService {
    AgentBridgeService.instance = new AgentBridgeService(log);
    return AgentBridgeService.instance;
  }

  static getInstance(): AgentBridgeService {
    if (!AgentBridgeService.instance) {
      throw new Error('AgentBridgeService not initialized');
    }
    return AgentBridgeService.instance;
  }

  onConnected(): void {
    this.log.appendLine('Agent bridge connected');
    this.broadcastAgentState();
  }

  onDisconnected(reason: string): void {
    this.log.appendLine(`Agent bridge disconnected: ${reason}`);
  }

  onMessage(type: string, payload: Record<string, unknown>): void {
    switch (type) {
      case 'agent_command':
        this.handleAgentCommand(payload);
        break;
      case 'session_update':
        this.log.appendLine('Session update received');
        break;
    }
  }

  onError(error: string): void {
    this.log.appendLine(`Agent bridge error: ${error}`);
  }

  private handleAgentCommand(payload: Record<string, unknown>): void {
    const commandType = payload.type as string;
    if (!commandType) { return; }
    this.log.appendLine(`Received agent command: ${commandType}`);

    switch (commandType) {
      case 'start_task': {
        const inner = payload.payload as Record<string, unknown> | undefined;
        const prompt = inner?.prompt as string;
        if (prompt) { this.startTask(prompt); }
        break;
      }
      case 'stop_task':
        this.stopCurrentTask();
        break;
      case 'approve_action':
        this.approveCurrentAction();
        break;
      case 'reject_action':
        this.rejectCurrentAction();
        break;
      case 'provide_input': {
        const inner = payload.payload as Record<string, unknown> | undefined;
        const input = inner?.input as string;
        if (input) { this.provideInput(input); }
        break;
      }
      case 'cancel_task':
        this.cancelCurrentTask();
        break;
    }
  }

  startTask(prompt: string): void {
    this.agentState = {
      ...this.agentState,
      status: 'running',
      currentTaskDescription: prompt,
      progress: 0,
    };
    this.broadcastAgentState();
    this.log.appendLine(`Starting task: ${prompt}`);
  }

  stopCurrentTask(): void {
    this.agentState = { ...this.agentState, status: 'idle', progress: 0 };
    this.broadcastAgentState();
    this.log.appendLine('Task stopped');
  }

  approveCurrentAction(): void {
    this.log.appendLine('Action approved');
    this.broadcastEvent('action_approved', {});
  }

  rejectCurrentAction(): void {
    this.log.appendLine('Action rejected');
    this.broadcastEvent('action_rejected', {});
  }

  provideInput(input: string): void {
    this.log.appendLine(`Input provided: ${input.substring(0, 50)}...`);
    this.broadcastEvent('input_provided', { input });
  }

  cancelCurrentTask(): void {
    this.agentState = { ...this.agentState, status: 'idle', currentTaskId: null, progress: 0 };
    this.broadcastAgentState();
    this.log.appendLine('Task cancelled');
  }

  updateAgentStatus(status: string, taskDescription?: string, progress = 0): void {
    this.agentState = {
      ...this.agentState,
      status,
      currentTaskDescription: taskDescription ?? this.agentState.currentTaskDescription,
      progress,
    };
    this.broadcastAgentState();
  }

  private broadcastAgentState(): void {
    const ws = WebSocketService.getInstance();
    if (!ws.isConnected) { return; }
    ws.sendAgentEvent('status_changed', this.agentState.currentTaskId || '', {
      status: this.agentState.status,
      currentTaskDescription: this.agentState.currentTaskDescription,
      progress: this.agentState.progress,
      model: this.agentState.model,
    });
  }

  private broadcastEvent(eventType: string, data: Record<string, unknown>): void {
    const ws = WebSocketService.getInstance();
    if (!ws.isConnected) { return; }
    ws.sendAgentEvent(eventType, this.agentState.currentTaskId || '', data);
  }
}
