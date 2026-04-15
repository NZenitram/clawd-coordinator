import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createHttpServer, IncomingMessage, Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, Server as HttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { AgentRegistry } from './registry.js';
import { logger } from '../shared/logger.js';
import { metrics } from '../shared/metrics.js';
import { TaskTracker, type TaskStore, type TaskStatus } from './tasks.js';
import { InMemoryTaskQueue, type TaskQueue } from './queue.js';
import { validateToken, validateAgentToken } from '../shared/auth.js';
import { createRestHandler } from './rest.js';
import { type UserStore, type UserRole } from './user-store.js';
import { checkPermission } from './rbac.js';
import {
  parseMessage,
  serializeMessage,
  createTaskDispatch,
  createTaskError,
  createTaskOutput,
  createCliResponse,
  createSessionListRequest,
  createAgentMessage,
  createAgentMessageAck,
  MessageDeduplicator,
  type AnyMessage,
} from '../protocol/messages.js';
import { safeSend } from '../shared/ws-utils.js';
import { RateLimiter } from '../shared/rate-limiter.js';

const MAX_CONNECTIONS_PER_IP = 10;

const RETRYABLE_ERROR_PATTERNS = [
  'disconnect',
  'timeout',
  'socket not open',
  'capacity',
  'unresponsive',
];

function isRetryableError(error: string): boolean {
  const lower = error.toLowerCase();
  return RETRYABLE_ERROR_PATTERNS.some(p => lower.includes(p));
}
// CLI connections: 100 messages/s; Agent connections: 500 messages/s
const CLI_RATE_LIMIT_TOKENS = 100;
const CLI_RATE_LIMIT_INTERVAL_MS = 1000;
const AGENT_RATE_LIMIT_TOKENS = 500;
const AGENT_RATE_LIMIT_INTERVAL_MS = 1000;

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
  store?: TaskStore;
  queue?: TaskQueue;
  userStore?: UserStore;
}

export const DEFAULT_ORG_ID = '__default__';

interface OrgState {
  agentSockets: Map<string, WebSocket>;
  cliSockets: Set<WebSocket>;
  taskSubscribers: Map<string, Set<WebSocket>>;
  taskOwners: Map<string, WebSocket>;
  registry: AgentRegistry;
  queue: TaskQueue;
  sessionListPending: Map<string, { cliSocket: WebSocket; cliRequestId: string; timer: ReturnType<typeof setTimeout> }>;
}

export class Coordinator {
  private wss: WebSocketServer | null = null;
  private httpsServer: HttpsServer | null = null;
  private httpServer: HttpServer | null = null;
  private httpConnections = new Set<import('node:net').Socket>();
  private httpsConnections = new Set<import('node:stream').Duplex>();
  private tasks: TaskStore;
  private stalenessTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private dedup = new MessageDeduplicator();
  private options: CoordinatorOptions;
  private ipConnectionCounts = new Map<string, number>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private orgStates = new Map<string, OrgState>();

  // Backward-compat aliases pointing at the default org's state
  private get registry(): AgentRegistry { return this.getOrgState(DEFAULT_ORG_ID).registry; }
  private get agentSockets(): Map<string, WebSocket> { return this.getOrgState(DEFAULT_ORG_ID).agentSockets; }
  private get cliSockets(): Set<WebSocket> { return this.getOrgState(DEFAULT_ORG_ID).cliSockets; }
  private get taskSubscribers(): Map<string, Set<WebSocket>> { return this.getOrgState(DEFAULT_ORG_ID).taskSubscribers; }
  private get taskOwners(): Map<string, WebSocket> { return this.getOrgState(DEFAULT_ORG_ID).taskOwners; }
  private get queue(): TaskQueue { return this.getOrgState(DEFAULT_ORG_ID).queue; }
  private get sessionListPending(): Map<string, { cliSocket: WebSocket; cliRequestId: string; timer: ReturnType<typeof setTimeout> }> {
    return this.getOrgState(DEFAULT_ORG_ID).sessionListPending;
  }

  private getOrgState(orgId: string): OrgState {
    let state = this.orgStates.get(orgId);
    if (!state) {
      state = {
        agentSockets: new Map(),
        cliSockets: new Set(),
        taskSubscribers: new Map(),
        taskOwners: new Map(),
        registry: new AgentRegistry(),
        queue: new InMemoryTaskQueue(),
        sessionListPending: new Map(),
      };
      this.orgStates.set(orgId, state);
    }
    return state;
  }

  constructor(options: CoordinatorOptions) {
    this.options = options;
    this.tasks = options.store ?? new TaskTracker();
    // Eagerly create the default org state
    this.getOrgState(DEFAULT_ORG_ID);
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      const verifyClient = (info: { req: IncomingMessage }, cb: (result: boolean, code?: number, message?: string) => void) => {
        const ip = info.req.socket.remoteAddress ?? 'unknown';
        const connCount = this.ipConnectionCounts.get(ip) ?? 0;
        if (connCount >= MAX_CONNECTIONS_PER_IP) {
          logger.warn({ remoteAddress: ip, connCount }, 'Per-IP connection limit reached');
          cb(false, 429, 'Too Many Connections');
          return;
        }
        const token = (info.req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');
        // 1. Legacy shared token → admin, default org (backward compat)
        if (validateToken(token, this.options.token)) {
          (info.req as any).__user = { userId: null, role: 'admin' as UserRole, orgId: DEFAULT_ORG_ID };
          cb(true); return;
        }
        // 2. Per-agent tokens → admin, default org
        if (this.options.agentTokens && validateAgentToken(token, this.options.agentTokens)) {
          (info.req as any).__user = { userId: null, role: 'admin' as UserRole, orgId: DEFAULT_ORG_ID };
          cb(true); return;
        }
        // 3. User API key via UserStore — resolve org from user membership
        if (this.options.userStore) {
          const resolved = this.options.userStore.resolveApiKey(token);
          if (resolved) {
            const memberships = this.options.userStore.getOrgMembership(resolved.userId);
            // Use the first org membership as the primary org; fall back to default
            const orgId = memberships.length > 0 ? memberships[0].orgId : DEFAULT_ORG_ID;
            (info.req as any).__user = { userId: resolved.userId, role: resolved.role as UserRole, orgId };
            cb(true); return;
          }
        }
        logger.warn({ remoteAddress: info.req.socket.remoteAddress }, 'Authentication failed');
        cb(false, 401, 'Unauthorized');
      };

      const restHandler = createRestHandler({
        store: this.tasks,
        registry: this.getOrgState(DEFAULT_ORG_ID).registry,
        token: this.options.token,
        queue: this.getOrgState(DEFAULT_ORG_ID).queue,
        userStore: this.options.userStore,
        getOrgRegistry: (orgId: string) => this.getOrgState(orgId).registry,
        getOrgQueue: (orgId: string) => this.getOrgState(orgId).queue,
        relayAgentMessage: (fromAgent, toAgent, correlationId, topic, body) => {
          return this.relayAgentMessageSync(fromAgent, toAgent, correlationId, topic, body);
        },
      });

      if (this.options.tls) {
        const httpsServer = createHttpsServer({
          cert: readFileSync(this.options.tls.cert),
          key: readFileSync(this.options.tls.key),
        }, restHandler);
        this.httpsServer = httpsServer;
        httpsServer.on('connection', (socket) => {
          this.httpsConnections.add(socket);
          socket.on('close', () => this.httpsConnections.delete(socket));
        });
        this.wss = new WebSocketServer({ server: httpsServer, maxPayload: 1 * 1024 * 1024, verifyClient });
        httpsServer.listen(this.options.port, () => resolve());
      } else {
        const httpServer = createHttpServer(restHandler);
        this.httpServer = httpServer;
        httpServer.on('connection', (socket) => {
          this.httpConnections.add(socket);
          socket.on('close', () => this.httpConnections.delete(socket));
        });
        this.wss = new WebSocketServer({ server: httpServer, maxPayload: 1 * 1024 * 1024, verifyClient });
        httpServer.listen(this.options.port, () => resolve());
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
        for (const [oid, state] of this.orgStates) {
          const stale = state.registry.getStaleAgents(stalenessThreshold);
          for (const agent of stale) {
            const socket = state.agentSockets.get(agent.name);
            if (socket) {
              socket.close(4002, 'Stale agent');
            }
            logger.info({ agent: agent.name, orgId: oid }, 'Stale agent evicted');
            state.registry.unregister(agent.name);
            state.agentSockets.delete(agent.name);
          }
          const deadBusy = state.registry.getDeadBusyAgents(300000); // 5 min
          for (const agent of deadBusy) {
            for (const taskId of [...agent.currentTaskIds]) {
              this.handleTaskFailureForOrg(taskId, agent.name, 'Agent became unresponsive', state);
            }
            const socket = state.agentSockets.get(agent.name);
            if (socket) socket.close(4002, 'Unresponsive busy agent');
            logger.info({ agent: agent.name, orgId: oid }, 'Dead busy agent evicted');
            state.registry.unregister(agent.name);
            state.agentSockets.delete(agent.name);
          }
        }
      }, stalenessInterval);

      const cleanupMaxAge = this.options.taskCleanupMaxAgeMs ?? 3600000; // 1 hour
      this.cleanupTimer = setInterval(() => {
        this.tasks.cleanup(cleanupMaxAge);
        for (const state of this.orgStates.values()) {
          for (const taskId of state.taskOwners.keys()) {
            if (!this.tasks.get(taskId)) {
              state.taskOwners.delete(taskId);
            }
          }
          for (const taskId of state.taskSubscribers.keys()) {
            if (!this.tasks.get(taskId)) {
              state.taskSubscribers.delete(taskId);
            }
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
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    if (!this.wss) return;
    for (const state of this.orgStates.values()) {
      for (const ws of state.agentSockets.values()) {
        ws.close();
      }
      for (const ws of state.cliSockets) {
        ws.close();
      }
    }
    return new Promise((resolve) => {
      this.wss!.close(() => {
        if (this.httpsServer) {
          for (const socket of this.httpsConnections) {
            socket.destroy();
          }
          this.httpsConnections.clear();
          this.httpsServer.close(() => resolve());
          this.httpsServer = null;
        } else if (this.httpServer) {
          for (const socket of this.httpConnections) {
            socket.destroy();
          }
          this.httpConnections.clear();
          this.httpServer.close(() => resolve());
          this.httpServer = null;
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

    // Track per-IP connection count
    const ip = req.socket.remoteAddress ?? 'unknown';
    this.ipConnectionCounts.set(ip, (this.ipConnectionCounts.get(ip) ?? 0) + 1);
    ws.on('close', () => {
      const current = this.ipConnectionCounts.get(ip) ?? 1;
      if (current <= 1) {
        this.ipConnectionCounts.delete(ip);
      } else {
        this.ipConnectionCounts.set(ip, current - 1);
      }
    });

    (ws as any).__isAlive = true;
    ws.on('pong', () => { (ws as any).__isAlive = true; });

    // Stash resolved user info on the socket for CLI permission checks
    const user = (req as any).__user as { userId: string | null; role: UserRole; orgId?: string } | undefined;
    const orgId = user?.orgId ?? DEFAULT_ORG_ID;
    (ws as any).__user = user ?? { userId: null, role: 'admin' as UserRole, orgId: DEFAULT_ORG_ID };
    (ws as any).__orgId = orgId;

    if (path === '/agent') {
      (ws as any).__rateLimiter = new RateLimiter(AGENT_RATE_LIMIT_TOKENS, AGENT_RATE_LIMIT_INTERVAL_MS);
      this.handleAgentConnection(ws, orgId);
    } else if (path === '/cli') {
      (ws as any).__rateLimiter = new RateLimiter(CLI_RATE_LIMIT_TOKENS, CLI_RATE_LIMIT_INTERVAL_MS);
      this.handleCliConnection(ws, orgId);
    } else {
      logger.warn({ path }, 'Unknown connection path');
      ws.close(4000, 'Unknown path');
    }
  }

  private handleAgentConnection(ws: WebSocket, orgId: string = DEFAULT_ORG_ID): void {
    let agentName: string | null = null;
    const state = this.getOrgState(orgId);

    ws.on('message', (raw) => {
      const limiter: RateLimiter | undefined = (ws as any).__rateLimiter;
      if (limiter && !limiter.tryConsume()) {
        logger.warn({ agent: agentName }, 'Agent rate limit exceeded');
        ws.close(4008, 'Rate limit exceeded');
        return;
      }

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
          const existingSocket = state.agentSockets.get(requestedName);
          if (existingSocket && existingSocket !== ws && existingSocket.readyState === WebSocket.OPEN) {
            logger.warn({ agent: requestedName }, 'Agent name hijack attempt rejected');
            ws.close(4003, `Agent name "${requestedName}" is already in use`);
            return;
          }
          if (state.registry.get(requestedName)) {
            state.registry.unregister(requestedName);
          }
          const rawMax = msg.payload.maxConcurrent;
          const maxConcurrent = (typeof rawMax === 'number' && Number.isInteger(rawMax) && rawMax >= 1 && rawMax <= 32) ? rawMax : 1;
          state.registry.register(requestedName, {
            os: msg.payload.os,
            arch: msg.payload.arch,
            maxConcurrent,
          });
          if (msg.payload.health) {
            state.registry.updateHealth(requestedName, {
              claudeAvailable: msg.payload.health.claudeAvailable,
              version: msg.payload.health.version,
            });
          }
          state.agentSockets.set(requestedName, ws);
          agentName = requestedName;
          metrics.incConnectedAgents();
          logger.info({ agent: agentName, os: msg.payload.os, arch: msg.payload.arch, orgId }, 'Agent registered');
          this.processQueueForOrg(requestedName, state);
          break;
        }
        case 'agent:heartbeat': {
          if (agentName) {
            state.registry.heartbeat(agentName);
            if (msg.payload.health) {
              state.registry.updateHealth(agentName, {
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
          const subscribers = state.taskSubscribers.get(taskId);
          if (subscribers) {
            const outMsg = serializeMessage(msg);
            for (const cli of subscribers) {
              safeSend(cli, outMsg);
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
          metrics.incCompleted();
          metrics.observeTaskDuration(taskId);
          metrics.setActiveTasks(this.countActiveTasks());
          if (agentName) {
            state.registry.removeTask(agentName, taskId);
            this.processQueueForOrg(agentName, state);
          }
          const subs = state.taskSubscribers.get(taskId);
          if (subs) {
            const completeMsg = serializeMessage(msg);
            for (const cli of subs) {
              if (cli.readyState === WebSocket.OPEN) {
                cli.send(completeMsg);
              }
            }
            state.taskSubscribers.delete(taskId);
          }
          break;
        }
        case 'task:error': {
          const { taskId, error } = msg.payload;
          const errorTask = this.tasks.get(taskId);
          if (!errorTask || errorTask.agentName !== agentName) return;
          logger.error({ taskId, error }, 'Task failed');
          metrics.incErrored();
          metrics.observeTaskDuration(taskId);
          metrics.setActiveTasks(this.countActiveTasks());
          this.handleTaskFailureForOrg(taskId, agentName ?? '', error, state);
          break;
        }
        case 'session:list-response': {
          const { requestId, sessions, error } = msg.payload;
          const pending = state.sessionListPending.get(requestId);
          if (!pending) break;
          clearTimeout(pending.timer);
          state.sessionListPending.delete(requestId);
          const { cliSocket, cliRequestId } = pending;
          if (cliSocket.readyState === WebSocket.OPEN) {
            cliSocket.send(serializeMessage(createCliResponse({
              requestId: cliRequestId,
              data: { sessions },
              error,
            })));
          }
          break;
        }
        case 'agent:message': {
          const { toAgent, correlationId } = msg.payload;
          const targetSocket = state.agentSockets.get(toAgent);
          if (!targetSocket) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(serializeMessage(createAgentMessageAck({ correlationId, status: 'unknown-agent' })));
            }
            break;
          }
          if (targetSocket.readyState !== WebSocket.OPEN) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(serializeMessage(createAgentMessageAck({ correlationId, status: 'agent-offline' })));
            }
            break;
          }
          targetSocket.send(serializeMessage(msg));
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(serializeMessage(createAgentMessageAck({ correlationId, status: 'delivered' })));
          }
          logger.info({ from: msg.payload.fromAgent, to: toAgent, correlationId }, 'Agent message relayed');
          break;
        }
        case 'agent:message-reply': {
          const { toAgent, correlationId } = msg.payload;
          const targetSocket = state.agentSockets.get(toAgent);
          if (!targetSocket) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(serializeMessage(createAgentMessageAck({ correlationId, status: 'unknown-agent' })));
            }
            break;
          }
          if (targetSocket.readyState !== WebSocket.OPEN) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(serializeMessage(createAgentMessageAck({ correlationId, status: 'agent-offline' })));
            }
            break;
          }
          targetSocket.send(serializeMessage(msg));
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(serializeMessage(createAgentMessageAck({ correlationId, status: 'delivered' })));
          }
          logger.info({ from: msg.payload.fromAgent, to: toAgent, correlationId }, 'Agent message-reply relayed');
          break;
        }
      }
    });

    ws.on('close', () => {
      if (agentName) {
        const agent = state.registry.get(agentName);
        if (agent && agent.currentTaskIds.length > 0) {
          for (const taskId of [...agent.currentTaskIds]) {
            this.handleTaskFailureForOrg(taskId, agentName!, 'Agent disconnected while task was running', state);
          }
        }
        logger.info({ agent: agentName, orgId }, 'Agent disconnected');
        metrics.decConnectedAgents();
        state.registry.unregister(agentName);
        state.agentSockets.delete(agentName);
      }
    });
  }

  private handleCliConnection(ws: WebSocket, orgId: string = DEFAULT_ORG_ID): void {
    const state = this.getOrgState(orgId);
    state.cliSockets.add(ws);

    ws.on('message', (raw) => {
      const limiter: RateLimiter | undefined = (ws as any).__rateLimiter;
      if (limiter && !limiter.tryConsume()) {
        logger.warn({}, 'CLI rate limit exceeded');
        ws.close(4008, 'Rate limit exceeded');
        return;
      }

      const msg = parseMessage(raw.toString());
      if (!msg) return;
      if (this.dedup.isDuplicate(msg.id)) return;

      if (msg.type === 'cli:request') {
        const user = (ws as any).__user as { userId: string | null; role: UserRole; orgId?: string };
        this.handleCliRequest(ws, msg.id, msg.payload, user, orgId);
      }
    });

    ws.on('close', () => {
      state.cliSockets.delete(ws);
      for (const [taskId, subs] of state.taskSubscribers) {
        subs.delete(ws);
        if (subs.size === 0) {
          state.taskSubscribers.delete(taskId);
        }
      }
      for (const [taskId, owner] of state.taskOwners) {
        if (owner === ws) {
          state.taskOwners.delete(taskId);
        }
      }
      for (const [reqId, pending] of state.sessionListPending) {
        if (pending.cliSocket === ws) {
          clearTimeout(pending.timer);
          state.sessionListPending.delete(reqId);
        }
      }
    });
  }

  private countActiveTasks(): number {
    return this.tasks.list('running').length;
  }

  /**
   * Central failure handler. Determines whether to retry or dead-letter a task.
   * Uses org-scoped state for queue and subscriber tracking.
   */
  private handleTaskFailureForOrg(taskId: string, agentName: string, error: string, state: OrgState): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    state.registry.removeTask(agentName, taskId);

    // Only retry if the agent socket is still open (transient failure).
    const agentSocket = state.agentSockets.get(agentName);
    const agentSocketOpen = agentSocket !== undefined && agentSocket.readyState === WebSocket.OPEN;
    if (agentSocketOpen && isRetryableError(error) && task.retryCount < task.maxRetries) {
      const delay = Math.min(5000 * Math.pow(2, task.retryCount), 60000);
      this.tasks.setRetrying(taskId);
      logger.info({ taskId, retryCount: task.retryCount + 1, delay }, 'Scheduling task retry');

      const retrySubs = state.taskSubscribers.get(taskId);
      if (retrySubs) {
        const retryNote = serializeMessage(createTaskOutput({
          taskId,
          data: `[coordinator] Task failed (${error}). Retrying in ${delay}ms (attempt ${task.retryCount + 1}/${task.maxRetries})...`,
        }));
        for (const cli of retrySubs) {
          if (cli.readyState === WebSocket.OPEN) {
            cli.send(retryNote);
          }
        }
      }

      const timer = setTimeout(() => {
        this.retryTimers.delete(taskId);
        state.queue.enqueue(taskId, agentName);
        this.processQueueForOrg(agentName, state);
      }, delay);
      this.retryTimers.set(taskId, timer);
    } else {
      // Dead-letter
      const finalTask = this.tasks.get(taskId);
      if (finalTask) {
        finalTask.deadLettered = true;
        finalTask.status = 'dead-letter';
        finalTask.error = error;
        finalTask.completedAt = Date.now();
      }
      logger.error({ taskId, error }, 'Task dead-lettered');

      const dlSubs = state.taskSubscribers.get(taskId);
      if (dlSubs) {
        const errMsg = serializeMessage(createTaskError({ taskId, error }));
        for (const cli of dlSubs) {
          if (cli.readyState === WebSocket.OPEN) {
            cli.send(errMsg);
          }
        }
        state.taskSubscribers.delete(taskId);
      }
      this.processQueueForOrg(agentName, state);
    }
  }

  /**
   * Synchronous relay for the REST POST /api/message endpoint.
   * Searches across all org states for the target agent.
   */
  relayAgentMessageSync(
    fromAgent: string,
    toAgent: string,
    correlationId: string,
    topic: string,
    body: string
  ): { status: 'delivered' | 'agent-offline' | 'unknown-agent' } {
    // Search all org states for the target agent
    for (const state of this.orgStates.values()) {
      const targetSocket = state.agentSockets.get(toAgent);
      if (targetSocket) {
        if (targetSocket.readyState !== WebSocket.OPEN) return { status: 'agent-offline' };
        targetSocket.send(serializeMessage(createAgentMessage({ fromAgent, toAgent, correlationId, topic, body })));
        logger.info({ from: fromAgent, to: toAgent, correlationId }, 'Agent message relayed via REST');
        return { status: 'delivered' };
      }
    }
    return { status: 'unknown-agent' };
  }

  private processQueueForOrg(agentName: string, state: OrgState): void {
    while (state.registry.hasCapacity(agentName)) {
      const taskId = state.queue.dequeue(agentName);
      if (!taskId) break;

      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'pending') continue;

      if (!state.registry.tryAddTask(agentName, task.id)) break;

      metrics.incDispatched();
      metrics.recordTaskStart(taskId);
      metrics.setQueueDepth(state.queue.depth());
      metrics.setActiveTasks(this.countActiveTasks() + 1);
      this.tasks.setRunning(taskId);
      logger.info({ agent: agentName, taskId, traceId: task.traceId }, 'Queued task dispatched');

      const agentWs = state.agentSockets.get(agentName);
      if (agentWs && agentWs.readyState === WebSocket.OPEN) {
        agentWs.send(serializeMessage(createTaskDispatch({
          taskId,
          prompt: task.prompt,
          sessionId: task.sessionId,
          traceId: task.traceId,
        })));
      } else {
        logger.error({ agent: agentName, taskId }, 'Agent socket not open for queued dispatch');
        this.handleTaskFailureForOrg(taskId, agentName, 'socket not open at dispatch time', state);
      }
    }
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
    payload: { command: string; args?: Record<string, unknown> },
    user: { userId: string | null; role: UserRole; orgId?: string } = { userId: null, role: 'admin' },
    orgId: string = DEFAULT_ORG_ID
  ): void {
    const { command, args } = payload;
    const state = this.getOrgState(orgId);

    // RBAC permission check
    if (!checkPermission(user.role, command)) {
      this.sendError(ws, requestId, 'Insufficient permissions');
      return;
    }

    switch (command) {
      case 'list-agents': {
        const agents = state.registry.list();
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
        const agent = state.registry.get(name);
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
        const agent = state.registry.get(agentName);

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
        const task = this.tasks.create({ agentName, prompt, sessionId, traceId, ownerUserId: user.userId ?? undefined, orgId });
        state.taskOwners.set(task.id, ws);

        if (!state.taskSubscribers.has(task.id)) {
          state.taskSubscribers.set(task.id, new Set());
        }
        state.taskSubscribers.get(task.id)!.add(ws);

        // Try immediate dispatch; if at capacity, queue the task
        if (!state.registry.tryAddTask(agentName, task.id)) {
          state.queue.enqueue(task.id, agentName);
          metrics.setQueueDepth(state.queue.depth());
          logger.info({ agent: agentName, taskId: task.id, traceId, queueDepth: state.queue.depth() }, 'Task queued');
          ws.send(serializeMessage(createCliResponse({
            requestId,
            data: { taskId: task.id, status: 'queued', queueDepth: state.queue.depth() },
          })));
          break;
        }

        metrics.incDispatched();
        metrics.recordTaskStart(task.id);
        metrics.setActiveTasks(this.countActiveTasks() + 1);
        this.tasks.setRunning(task.id);
        logger.info({ agent: agentName, taskId: task.id, traceId, orgId }, 'Task dispatched');

        const agentWs = state.agentSockets.get(agentName);
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
          state.registry.removeTask(agentName, task.id);
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
        const validStatuses: TaskStatus[] = ['pending', 'running', 'completed', 'error', 'dead-letter'];
        const statusArg = typeof args?.status === 'string' ? args.status : undefined;
        if (statusArg && !validStatuses.includes(statusArg as TaskStatus)) {
          this.sendError(ws, requestId, `Invalid status filter: ${statusArg}. Valid: ${validStatuses.join(', ')}`);
          return;
        }
        const tasks = this.tasks.list(statusArg as TaskStatus | undefined, orgId);
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
        const taskOwner = state.taskOwners.get(taskId);
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
        const subOwner = state.taskOwners.get(taskId);
        if (subOwner && subOwner !== ws) {
          this.sendError(ws, requestId, 'Not authorized to subscribe to this task');
          return;
        }
        if (!state.taskSubscribers.has(taskId)) {
          state.taskSubscribers.set(taskId, new Set());
        }
        state.taskSubscribers.get(taskId)!.add(ws);
        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { subscribed: true, taskId },
        })));
        break;
      }
      case 'list-sessions': {
        const agentName = this.requireStringArg(args, 'agentName');
        if (!agentName) {
          this.sendError(ws, requestId, 'Missing required argument: agentName');
          return;
        }
        const agent = state.registry.get(agentName);
        if (!agent) {
          this.sendError(ws, requestId, `Agent "${agentName}" not found`);
          return;
        }
        const agentWs = state.agentSockets.get(agentName);
        if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
          this.sendError(ws, requestId, `Agent "${agentName}" is not reachable`);
          return;
        }
        // Use requestId as the correlation key so we can route the response back
        const timer = setTimeout(() => {
          const pending = state.sessionListPending.get(requestId);
          if (pending) {
            state.sessionListPending.delete(requestId);
            this.sendError(pending.cliSocket, pending.cliRequestId, 'Session list request timed out');
          }
        }, 30000);
        state.sessionListPending.set(requestId, { cliSocket: ws, cliRequestId: requestId, timer });
        agentWs.send(serializeMessage(createSessionListRequest({
          agentName,
          requestId,
        })));
        break;
      }
      default: {
        this.sendError(ws, requestId, `Unknown command: ${command}`);
      }
    }
  }
}
