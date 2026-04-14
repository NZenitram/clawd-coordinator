import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import { AgentRegistry } from './registry.js';
import { TaskTracker, type TaskStatus } from './tasks.js';
import { validateToken } from '../shared/auth.js';
import {
  parseMessage,
  serializeMessage,
  createTaskDispatch,
  createCliResponse,
  type AnyMessage,
} from '../protocol/messages.js';

export interface CoordinatorOptions {
  port: number;
  token: string;
  stalenessThresholdMs?: number;
  stalenessCheckIntervalMs?: number;
  taskCleanupMaxAgeMs?: number;
}

export class Coordinator {
  private wss: WebSocketServer | null = null;
  private registry = new AgentRegistry();
  private tasks = new TaskTracker();
  private agentSockets = new Map<string, WebSocket>();
  private cliSockets = new Set<WebSocket>();
  private taskSubscribers = new Map<string, Set<WebSocket>>();
  private stalenessTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private options: CoordinatorOptions;

  constructor(options: CoordinatorOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.options.port, maxPayload: 1 * 1024 * 1024 }, () => {
        resolve();
      });
      this.wss.on('connection', (ws, req) => {
        this.handleConnection(ws, req);
      });

      const stalenessThreshold = this.options.stalenessThresholdMs ?? 90000;
      const stalenessInterval = this.options.stalenessCheckIntervalMs ?? 30000;
      this.stalenessTimer = setInterval(() => {
        const stale = this.registry.getStaleAgents(stalenessThreshold);
        for (const agent of stale) {
          const socket = this.agentSockets.get(agent.name);
          if (socket) {
            socket.close(4002, 'Stale agent');
          }
          this.registry.unregister(agent.name);
          this.agentSockets.delete(agent.name);
        }
      }, stalenessInterval);

      const cleanupMaxAge = this.options.taskCleanupMaxAgeMs ?? 3600000; // 1 hour
      this.cleanupTimer = setInterval(() => {
        this.tasks.cleanup(cleanupMaxAge);
      }, 60000);
    });
  }

  async stop(): Promise<void> {
    if (this.stalenessTimer) {
      clearInterval(this.stalenessTimer);
      this.stalenessTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (!this.wss) return;
    for (const ws of this.agentSockets.values()) {
      ws.close();
    }
    for (const ws of this.cliSockets) {
      ws.close();
    }
    return new Promise((resolve) => {
      this.wss!.close(() => resolve());
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/', `http://localhost:${this.options.port}`);
    const token = url.searchParams.get('token') ?? '';
    const path = url.pathname;

    if (!validateToken(token, this.options.token)) {
      ws.close(4001, 'Invalid token');
      return;
    }

    if (path === '/agent') {
      this.handleAgentConnection(ws);
    } else if (path === '/cli') {
      this.handleCliConnection(ws);
    } else {
      ws.close(4000, 'Unknown path');
    }
  }

  private handleAgentConnection(ws: WebSocket): void {
    let agentName: string | null = null;

    ws.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;

      switch (msg.type) {
        case 'agent:register': {
          agentName = msg.payload.name;
          // If agent already exists, close the old socket and replace
          const existingSocket = this.agentSockets.get(agentName);
          if (existingSocket && existingSocket !== ws) {
            existingSocket.close();
          }
          if (this.registry.get(agentName)) {
            this.registry.unregister(agentName);
          }
          this.registry.register(agentName, {
            os: msg.payload.os,
            arch: msg.payload.arch,
          });
          this.agentSockets.set(agentName, ws);
          break;
        }
        case 'agent:heartbeat': {
          if (agentName) {
            this.registry.heartbeat(agentName);
          }
          break;
        }
        case 'task:output': {
          const { taskId, data } = msg.payload;
          this.tasks.appendOutput(taskId, data);
          const subscribers = this.taskSubscribers.get(taskId);
          if (subscribers) {
            const outMsg = serializeMessage(msg);
            for (const cli of subscribers) {
              if (cli.readyState === WebSocket.OPEN) {
                cli.send(outMsg);
              }
            }
          }
          break;
        }
        case 'task:complete': {
          const { taskId } = msg.payload;
          this.tasks.setCompleted(taskId);
          if (agentName) {
            this.registry.setIdle(agentName);
          }
          const subs = this.taskSubscribers.get(taskId);
          if (subs) {
            const completeMsg = serializeMessage(msg);
            for (const cli of subs) {
              if (cli.readyState === WebSocket.OPEN) {
                cli.send(completeMsg);
              }
            }
            this.taskSubscribers.delete(taskId);
          }
          break;
        }
        case 'task:error': {
          const { taskId, error } = msg.payload;
          this.tasks.setError(taskId, error);
          if (agentName) {
            this.registry.setIdle(agentName);
          }
          const errSubs = this.taskSubscribers.get(taskId);
          if (errSubs) {
            const errMsg = serializeMessage(msg);
            for (const cli of errSubs) {
              if (cli.readyState === WebSocket.OPEN) {
                cli.send(errMsg);
              }
            }
            this.taskSubscribers.delete(taskId);
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      if (agentName) {
        this.registry.unregister(agentName);
        this.agentSockets.delete(agentName);
      }
    });
  }

  private handleCliConnection(ws: WebSocket): void {
    this.cliSockets.add(ws);

    ws.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;

      if (msg.type === 'cli:request') {
        this.handleCliRequest(ws, msg.id, msg.payload);
      }
    });

    ws.on('close', () => {
      this.cliSockets.delete(ws);
      for (const [taskId, subs] of this.taskSubscribers) {
        subs.delete(ws);
        if (subs.size === 0) {
          this.taskSubscribers.delete(taskId);
        }
      }
    });
  }

  private sendError(ws: WebSocket, requestId: string, error: string): void {
    ws.send(serializeMessage(createCliResponse({ requestId, data: null, error })));
  }

  private requireStringArg(args: Record<string, unknown> | undefined, key: string): string | null {
    const val = args?.[key];
    if (typeof val === 'string' && val.length > 0) return val;
    return null;
  }

  private handleCliRequest(
    ws: WebSocket,
    requestId: string,
    payload: { command: string; args?: Record<string, unknown> }
  ): void {
    const { command, args } = payload;

    switch (command) {
      case 'list-agents': {
        const agents = this.registry.list();
        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { agents },
        })));
        break;
      }
      case 'get-agent': {
        const name = this.requireStringArg(args, 'name');
        if (!name) {
          this.sendError(ws, requestId, 'Missing required argument: name');
          return;
        }
        const agent = this.registry.get(name);
        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { agent },
        })));
        break;
      }
      case 'dispatch-task': {
        const agentName = this.requireStringArg(args, 'agentName');
        const prompt = this.requireStringArg(args, 'prompt');
        if (!agentName || !prompt) {
          this.sendError(ws, requestId, 'Missing required arguments: agentName, prompt');
          return;
        }
        const sessionId = args?.sessionId as string | undefined;
        const agent = this.registry.get(agentName);

        if (!agent) {
          this.sendError(ws, requestId, `Agent "${agentName}" not found`);
          return;
        }
        if (agent.status === 'busy') {
          this.sendError(ws, requestId, `Agent "${agentName}" is busy with task ${agent.currentTaskId}`);
          return;
        }

        const task = this.tasks.create({ agentName, prompt, sessionId });
        this.tasks.setRunning(task.id);
        this.registry.setBusy(agentName, task.id);

        if (!this.taskSubscribers.has(task.id)) {
          this.taskSubscribers.set(task.id, new Set());
        }
        this.taskSubscribers.get(task.id)!.add(ws);

        const agentWs = this.agentSockets.get(agentName);
        if (agentWs && agentWs.readyState === WebSocket.OPEN) {
          agentWs.send(serializeMessage(createTaskDispatch({
            taskId: task.id,
            prompt,
            sessionId,
          })));
        }

        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { taskId: task.id, status: 'dispatched' },
        })));
        break;
      }
      case 'list-tasks': {
        const validStatuses: TaskStatus[] = ['pending', 'running', 'completed', 'error'];
        const statusArg = args?.status as string | undefined;
        if (statusArg && !validStatuses.includes(statusArg as TaskStatus)) {
          this.sendError(ws, requestId, `Invalid status filter: ${statusArg}. Valid: ${validStatuses.join(', ')}`);
          return;
        }
        const tasks = this.tasks.list(statusArg as TaskStatus | undefined);
        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { tasks },
        })));
        break;
      }
      case 'get-task': {
        const taskId = this.requireStringArg(args, 'taskId');
        if (!taskId) {
          this.sendError(ws, requestId, 'Missing required argument: taskId');
          return;
        }
        const task = this.tasks.get(taskId);
        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { task },
        })));
        break;
      }
      case 'subscribe-task': {
        const taskId = this.requireStringArg(args, 'taskId');
        if (!taskId) {
          this.sendError(ws, requestId, 'Missing required argument: taskId');
          return;
        }
        if (!this.taskSubscribers.has(taskId)) {
          this.taskSubscribers.set(taskId, new Set());
        }
        this.taskSubscribers.get(taskId)!.add(ws);
        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { subscribed: true, taskId },
        })));
        break;
      }
      default: {
        this.sendError(ws, requestId, `Unknown command: ${command}`);
      }
    }
  }
}
