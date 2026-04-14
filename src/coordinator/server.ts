import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import { AgentRegistry } from './registry.js';
import { TaskTracker } from './tasks.js';
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
}

export class Coordinator {
  private wss: WebSocketServer | null = null;
  private registry = new AgentRegistry();
  private tasks = new TaskTracker();
  private agentSockets = new Map<string, WebSocket>();
  private cliSockets = new Set<WebSocket>();
  private taskSubscribers = new Map<string, Set<WebSocket>>();
  private options: CoordinatorOptions;

  constructor(options: CoordinatorOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.options.port }, () => {
        resolve();
      });
      this.wss.on('connection', (ws, req) => {
        this.handleConnection(ws, req);
      });
    });
  }

  async stop(): Promise<void> {
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
    });
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
        const agent = this.registry.get(args?.name as string);
        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { agent },
        })));
        break;
      }
      case 'dispatch-task': {
        const agentName = args?.agentName as string;
        const prompt = args?.prompt as string;
        const sessionId = args?.sessionId as string | undefined;
        const agent = this.registry.get(agentName);

        if (!agent) {
          ws.send(serializeMessage(createCliResponse({
            requestId,
            data: null,
            error: `Agent "${agentName}" not found`,
          })));
          return;
        }
        if (agent.status === 'busy') {
          ws.send(serializeMessage(createCliResponse({
            requestId,
            data: null,
            error: `Agent "${agentName}" is busy with task ${agent.currentTaskId}`,
          })));
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
        const status = args?.status as string | undefined;
        const tasks = this.tasks.list(status as any);
        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { tasks },
        })));
        break;
      }
      case 'get-task': {
        const task = this.tasks.get(args?.taskId as string);
        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { task },
        })));
        break;
      }
      case 'subscribe-task': {
        const taskId = args?.taskId as string;
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
        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: null,
          error: `Unknown command: ${command}`,
        })));
      }
    }
  }
}
