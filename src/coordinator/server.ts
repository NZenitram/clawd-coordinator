import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'node:http';
import { createServer as createHttpsServer, Server as HttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { AgentRegistry } from './registry.js';
import { logger } from '../shared/logger.js';
import { TaskTracker, type TaskStatus } from './tasks.js';
import { validateToken, validateAgentToken } from '../shared/auth.js';
import {
  parseMessage,
  serializeMessage,
  createTaskDispatch,
  createTaskError,
  createCliResponse,
  MessageDeduplicator,
  type AnyMessage,
} from '../protocol/messages.js';

export interface CoordinatorOptions {
  port: number;
  token: string;
  stalenessThresholdMs?: number;
  stalenessCheckIntervalMs?: number;
  taskCleanupMaxAgeMs?: number;
  tls?: {
    cert: string;
    key: string;
  };
  agentTokens?: Record<string, string>;
}

export class Coordinator {
  private wss: WebSocketServer | null = null;
  private httpsServer: HttpsServer | null = null;
  private registry = new AgentRegistry();
  private tasks = new TaskTracker();
  private agentSockets = new Map<string, WebSocket>();
  private cliSockets = new Set<WebSocket>();
  private taskSubscribers = new Map<string, Set<WebSocket>>();
  private stalenessTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private dedup = new MessageDeduplicator();
  private taskOwners = new Map<string, WebSocket>();
  private options: CoordinatorOptions;

  constructor(options: CoordinatorOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      const verifyClient = (info: { req: IncomingMessage }, cb: (result: boolean, code?: number, message?: string) => void) => {
        const token = (info.req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');
        if (validateToken(token, this.options.token)) { cb(true); return; }
        if (this.options.agentTokens && validateAgentToken(token, this.options.agentTokens)) { cb(true); return; }
        logger.warn({ remoteAddress: info.req.socket.remoteAddress }, 'Authentication failed');
        cb(false, 401, 'Unauthorized');
      };

      if (this.options.tls) {
        const httpsServer = createHttpsServer({
          cert: readFileSync(this.options.tls.cert),
          key: readFileSync(this.options.tls.key),
        });
        this.httpsServer = httpsServer;
        this.wss = new WebSocketServer({ server: httpsServer, maxPayload: 1 * 1024 * 1024, verifyClient });
        httpsServer.listen(this.options.port, () => resolve());
      } else {
        this.wss = new WebSocketServer({ port: this.options.port, maxPayload: 1 * 1024 * 1024, verifyClient }, () => {
          resolve();
        });
      }
      logger.info({ port: this.options.port }, 'Coordinator started');
      this.wss.on('connection', (ws, req) => {
        this.handleConnection(ws, req);
      });

      this.pingTimer = setInterval(() => {
        if (!this.wss) return;
        for (const client of this.wss.clients) {
          if ((client as any).__isAlive === false) {
            client.terminate();
            continue;
          }
          (client as any).__isAlive = false;
          client.ping();
        }
      }, 30000);

      const stalenessThreshold = this.options.stalenessThresholdMs ?? 90000;
      const stalenessInterval = this.options.stalenessCheckIntervalMs ?? 30000;
      this.stalenessTimer = setInterval(() => {
        const stale = this.registry.getStaleAgents(stalenessThreshold);
        for (const agent of stale) {
          const socket = this.agentSockets.get(agent.name);
          if (socket) {
            socket.close(4002, 'Stale agent');
          }
          logger.info({ agent: agent.name }, 'Stale agent evicted');
          this.registry.unregister(agent.name);
          this.agentSockets.delete(agent.name);
        }
        const deadBusy = this.registry.getDeadBusyAgents(300000); // 5 min
        for (const agent of deadBusy) {
          for (const taskId of agent.currentTaskIds) {
            this.tasks.setError(taskId, 'Agent became unresponsive');
            const subs = this.taskSubscribers.get(taskId);
            if (subs) {
              const errMsg = serializeMessage(createTaskError({
                taskId,
                error: 'Agent became unresponsive',
              }));
              for (const cli of subs) {
                if (cli.readyState === WebSocket.OPEN) {
                  cli.send(errMsg);
                }
              }
              this.taskSubscribers.delete(taskId);
            }
          }
          const socket = this.agentSockets.get(agent.name);
          if (socket) socket.close(4002, 'Unresponsive busy agent');
          logger.info({ agent: agent.name }, 'Dead busy agent evicted');
          this.registry.unregister(agent.name);
          this.agentSockets.delete(agent.name);
        }
      }, stalenessInterval);

      const cleanupMaxAge = this.options.taskCleanupMaxAgeMs ?? 3600000; // 1 hour
      this.cleanupTimer = setInterval(() => {
        this.tasks.cleanup(cleanupMaxAge);
        for (const taskId of this.taskOwners.keys()) {
          if (!this.tasks.get(taskId)) {
            this.taskOwners.delete(taskId);
          }
        }
        for (const taskId of this.taskSubscribers.keys()) {
          if (!this.tasks.get(taskId)) {
            this.taskSubscribers.delete(taskId);
          }
        }
      }, 60000);
    });
  }

  async stop(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
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
      this.wss!.close(() => {
        if (this.httpsServer) {
          this.httpsServer.close(() => resolve());
          this.httpsServer = null;
        } else {
          resolve();
        }
      });
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Auth already verified by verifyClient — just route by path
    const url = new URL(req.url ?? '/', `http://localhost:${this.options.port}`);
    const path = url.pathname;

    (ws as any).__isAlive = true;
    ws.on('pong', () => { (ws as any).__isAlive = true; });

    if (path === '/agent') {
      this.handleAgentConnection(ws);
    } else if (path === '/cli') {
      this.handleCliConnection(ws);
    } else {
      logger.warn({ path }, 'Unknown connection path');
      ws.close(4000, 'Unknown path');
    }
  }

  private handleAgentConnection(ws: WebSocket): void {
    let agentName: string | null = null;

    ws.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;
      if (this.dedup.isDuplicate(msg.id)) return;

      switch (msg.type) {
        case 'agent:register': {
          const requestedName = msg.payload.name;
          // Validate agent name format
          if (typeof requestedName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(requestedName)) {
            logger.warn({ agent: requestedName }, 'Invalid agent name format');
            ws.close(4004, 'Invalid agent name format');
            return;
          }
          // Reject if agent name is already in use by a live connection
          const existingSocket = this.agentSockets.get(requestedName);
          if (existingSocket && existingSocket !== ws && existingSocket.readyState === WebSocket.OPEN) {
            logger.warn({ agent: requestedName }, 'Agent name hijack attempt rejected');
            ws.close(4003, `Agent name "${requestedName}" is already in use`);
            return;
          }
          if (this.registry.get(requestedName)) {
            this.registry.unregister(requestedName);
          }
          const rawMax = msg.payload.maxConcurrent;
          const maxConcurrent = (typeof rawMax === 'number' && Number.isInteger(rawMax) && rawMax >= 1 && rawMax <= 32) ? rawMax : 1;
          this.registry.register(requestedName, {
            os: msg.payload.os,
            arch: msg.payload.arch,
            maxConcurrent,
          });
          if (msg.payload.health) {
            this.registry.updateHealth(requestedName, {
              claudeAvailable: msg.payload.health.claudeAvailable,
              version: msg.payload.health.version,
            });
          }
          this.agentSockets.set(requestedName, ws);
          agentName = requestedName;
          logger.info({ agent: agentName, os: msg.payload.os, arch: msg.payload.arch }, 'Agent registered');
          break;
        }
        case 'agent:heartbeat': {
          if (agentName) {
            this.registry.heartbeat(agentName);
            if (msg.payload.health) {
              this.registry.updateHealth(agentName, {
                claudeAvailable: msg.payload.health.claudeAvailable,
                version: msg.payload.health.version,
              });
            }
          }
          break;
        }
        case 'task:output': {
          const { taskId, data } = msg.payload;
          const outputTask = this.tasks.get(taskId);
          if (!outputTask || outputTask.agentName !== agentName) return;
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
          const completeTask = this.tasks.get(taskId);
          if (!completeTask || completeTask.agentName !== agentName) return;
          logger.info({ taskId }, 'Task completed');
          this.tasks.setCompleted(taskId);
          if (agentName) {
            this.registry.removeTask(agentName, taskId);
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
          const errorTask = this.tasks.get(taskId);
          if (!errorTask || errorTask.agentName !== agentName) return;
          logger.error({ taskId, error }, 'Task failed');
          this.tasks.setError(taskId, error);
          if (agentName) {
            this.registry.removeTask(agentName, taskId);
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
        const agent = this.registry.get(agentName);
        if (agent && agent.currentTaskIds.length > 0) {
          for (const taskId of agent.currentTaskIds) {
            this.tasks.setError(taskId, 'Agent disconnected while task was running');
            const subs = this.taskSubscribers.get(taskId);
            if (subs) {
              const errMsg = serializeMessage(createTaskError({
                taskId,
                error: 'Agent disconnected while task was running',
              }));
              for (const cli of subs) {
                if (cli.readyState === WebSocket.OPEN) {
                  cli.send(errMsg);
                }
              }
              this.taskSubscribers.delete(taskId);
            }
          }
        }
        logger.info({ agent: agentName }, 'Agent disconnected');
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
      if (this.dedup.isDuplicate(msg.id)) return;

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
      for (const [taskId, owner] of this.taskOwners) {
        if (owner === ws) {
          this.taskOwners.delete(taskId);
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
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
        const agent = this.registry.get(agentName);

        if (!agent) {
          this.sendError(ws, requestId, `Agent "${agentName}" not found`);
          return;
        }
        if (agent.health && !agent.health.claudeAvailable) {
          this.sendError(ws, requestId, `Agent "${agentName}" is unhealthy: Claude CLI not available`);
          return;
        }

        const traceId = randomUUID();
        const rawBudget = args?.maxBudgetUsd;
        const maxBudgetUsd = (typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget > 0 && rawBudget <= 10000) ? rawBudget : undefined;
        const task = this.tasks.create({ agentName, prompt, sessionId, traceId });
        this.tasks.setRunning(task.id);
        if (!this.registry.tryAddTask(agentName, task.id)) {
          this.tasks.setError(task.id, 'Agent at capacity');
          this.sendError(ws, requestId, `Agent "${agentName}" is at capacity (${agent.currentTaskIds.length}/${agent.maxConcurrent} tasks)`);
          return;
        }
        this.taskOwners.set(task.id, ws);
        logger.info({ agent: agentName, taskId: task.id, traceId }, 'Task dispatched');

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
            traceId,
            maxBudgetUsd,
          })));
        } else {
          logger.error({ agent: agentName, taskId: task.id, traceId }, 'Agent socket not open, dispatch not delivered');
          this.tasks.setError(task.id, 'Agent socket not open at dispatch time');
          this.registry.removeTask(agentName, task.id);
          this.sendError(ws, requestId, `Agent "${agentName}" is not reachable`);
          return;
        }

        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { taskId: task.id, status: 'dispatched' },
        })));
        break;
      }
      case 'list-tasks': {
        const validStatuses: TaskStatus[] = ['pending', 'running', 'completed', 'error'];
        const statusArg = typeof args?.status === 'string' ? args.status : undefined;
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
        const taskOwner = this.taskOwners.get(taskId);
        if (taskOwner && taskOwner !== ws) {
          this.sendError(ws, requestId, 'Not authorized to access this task');
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
        const subOwner = this.taskOwners.get(taskId);
        if (subOwner && subOwner !== ws) {
          this.sendError(ws, requestId, 'Not authorized to subscribe to this task');
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
