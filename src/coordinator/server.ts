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
import { TransferManager } from './transfer.js';
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
  createAgentSelfUpdate,
  createFilePullRequest,
  createFileTransferStart,
  createFileTransferError,
  MessageDeduplicator,
  type AnyMessage,
  type FileTransferStartPayload,
  type FileChunkPayload,
  type FileChunkAckPayload,
  type AgentSelfUpdateResponsePayload,
} from '../protocol/messages.js';
import { safeSend } from '../shared/ws-utils.js';
import { RateLimiter } from '../shared/rate-limiter.js';
import { Scheduler, type ScheduleStore } from './scheduler.js';
import { InMemoryWebhookStore, type WebhookStore } from './webhook-store.js';

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
  scheduler?: Scheduler;
  scheduleStore?: ScheduleStore;
  webhookStore?: WebhookStore;
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
  selfUpdatePending: Map<string, { cliSocket: WebSocket; cliRequestId: string; timer: ReturnType<typeof setTimeout> }>;
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
  private scheduler: Scheduler | null = null;
  private webhookStore: WebhookStore;
  private dedup = new MessageDeduplicator();
  private options: CoordinatorOptions;
  private ipConnectionCounts = new Map<string, number>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private orgStates = new Map<string, OrgState>();
  private transferManager = new TransferManager();

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
  private get selfUpdatePending(): Map<string, { cliSocket: WebSocket; cliRequestId: string; timer: ReturnType<typeof setTimeout> }> {
    return this.getOrgState(DEFAULT_ORG_ID).selfUpdatePending;
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
        selfUpdatePending: new Map(),
      };
      this.orgStates.set(orgId, state);
    }
    return state;
  }

  constructor(options: CoordinatorOptions) {
    this.options = options;
    this.tasks = options.store ?? new TaskTracker();
    this.webhookStore = options.webhookStore ?? new InMemoryWebhookStore();
    // Eagerly create the default org state
    this.getOrgState(DEFAULT_ORG_ID);

    // Wire scheduler if a schedule store was provided or a custom scheduler was passed
    if (options.scheduler) {
      this.scheduler = options.scheduler;
    } else if (options.scheduleStore) {
      this.scheduler = new Scheduler(options.scheduleStore, (agentName, prompt, opts) => {
        const orgId = opts?.orgId ?? DEFAULT_ORG_ID;
        const task = this.tasks.create({
          agentName,
          prompt,
          orgId,
          allowedTools: opts?.allowedTools,
        });
        const activeQueue = this.getOrgState(orgId).queue;
        activeQueue.enqueue(task.id, agentName);
        logger.info({ taskId: task.id, agentName, orgId }, 'Scheduled task dispatched');
      });
    }
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
        scheduleStore: this.options.scheduleStore,
        webhookStore: this.webhookStore,
        getOrgRegistry: (orgId: string) => this.getOrgState(orgId).registry,
        getOrgQueue: (orgId: string) => this.getOrgState(orgId).queue,
        relayAgentMessage: (fromAgent, toAgent, correlationId, topic, body) => {
          return this.relayAgentMessageSync(fromAgent, toAgent, correlationId, topic, body);
        },
        transferManager: this.transferManager,
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
      if (this.scheduler) {
        this.scheduler.start();
      }
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
    if (this.scheduler) {
      this.scheduler.stop();
    }
    this.transferManager.stop();
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
          const regAllowedTools = Array.isArray(msg.payload.allowedTools)
            ? (msg.payload.allowedTools as unknown[]).filter((t): t is string => typeof t === 'string')
            : undefined;
          const regAddDirs = Array.isArray(msg.payload.addDirs)
            ? (msg.payload.addDirs as unknown[]).filter((d): d is string => typeof d === 'string')
            : undefined;
          const regPermissionMode = typeof msg.payload.permissionMode === 'string' ? msg.payload.permissionMode : undefined;
          const coordVersion = typeof msg.payload.coordVersion === 'string' ? msg.payload.coordVersion : undefined;
          const regPool = typeof msg.payload.pool === 'string' && msg.payload.pool.length > 0 ? msg.payload.pool : undefined;
          state.registry.register(requestedName, {
            os: msg.payload.os,
            arch: msg.payload.arch,
            coordVersion,
            maxConcurrent,
            allowedTools: regAllowedTools,
            addDirs: regAddDirs,
            permissionMode: regPermissionMode,
            pool: regPool,
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
        case 'agent:self-update-response': {
          const suPayload = msg.payload as AgentSelfUpdateResponsePayload;
          const { requestId } = suPayload;
          const pending = state.selfUpdatePending.get(requestId);
          if (!pending) break;
          clearTimeout(pending.timer);
          state.selfUpdatePending.delete(requestId);
          const { cliSocket, cliRequestId } = pending;
          if (cliSocket.readyState === WebSocket.OPEN) {
            cliSocket.send(serializeMessage(createCliResponse({
              requestId: cliRequestId,
              data: {
                success: suPayload.success,
                message: suPayload.message,
                oldVersion: suPayload.oldVersion,
                newVersion: suPayload.newVersion,
              },
              error: suPayload.success ? undefined : suPayload.message,
            })));
          }
          break;
        }
        case 'agent:message': {
          // Enforce sender identity
          if (agentName) msg.payload.fromAgent = agentName;
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
          // Enforce sender identity
          if (agentName) msg.payload.fromAgent = agentName;
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
        case 'file:transfer-start': {
          // Agent is starting a send (responding to pull-request or push from agent)
          const payload = msg.payload as FileTransferStartPayload;
          const rawMsg = raw.toString();
          // Relay to the dest socket tracked in TransferManager
          const relayed = this.transferManager.relayChunk(payload.transferId, rawMsg);
          if (!relayed) {
            // No active transfer — relay to all CLI sockets (pull response)
            for (const cli of state.cliSockets) {
              if (cli.readyState === WebSocket.OPEN) safeSend(cli, rawMsg);
            }
          }
          break;
        }
        case 'file:chunk': {
          const payload = msg.payload as FileChunkPayload;
          const rawMsg = raw.toString();
          this.transferManager.relayChunkMsg(payload.transferId, rawMsg, payload);
          break;
        }
        case 'file:chunk-ack': {
          const payload = msg.payload as FileChunkAckPayload;
          const rawMsg = raw.toString();
          // Agent acks go back to source (could be CLI or another agent)
          const relayed = this.transferManager.relayAckMsg(payload.transferId, rawMsg, payload);
          if (!relayed) {
            // No active transfer entry — relay to all CLI sockets
            for (const cli of state.cliSockets) {
              if (cli.readyState === WebSocket.OPEN) safeSend(cli, rawMsg);
            }
          }
          break;
        }
        case 'file:transfer-complete': {
          const { transferId } = msg.payload as { transferId: string };
          const rawMsg = raw.toString();
          // Relay to dest, then complete
          this.transferManager.relayChunk(transferId, rawMsg); // reuse relay to dest
          this.transferManager.completeTransfer(transferId);
          // Also broadcast to CLI sockets
          for (const cli of state.cliSockets) {
            if (cli.readyState === WebSocket.OPEN) safeSend(cli, rawMsg);
          }
          break;
        }
        case 'file:transfer-error': {
          const { transferId } = msg.payload as { transferId: string };
          const rawMsg = raw.toString();
          this.transferManager.errorTransfer(transferId, (msg.payload as { transferId: string; error: string }).error);
          for (const cli of state.cliSockets) {
            if (cli.readyState === WebSocket.OPEN) safeSend(cli, rawMsg);
          }
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
      } else if (msg.type === 'file:transfer-start') {
        // CLI is pushing a file — relay to dest agent via TransferManager
        const payload = msg.payload as FileTransferStartPayload;
        const rawMsg = raw.toString();
        const relayed = this.transferManager.relayChunk(payload.transferId, rawMsg);
        if (!relayed) {
          // Relay to all agent sockets (coordinator doesn't know dest yet — agents filter by transferId)
          const destAgentName = payload.destAgent;
          if (destAgentName) {
            const agentWs = state.agentSockets.get(destAgentName);
            if (agentWs && agentWs.readyState === WebSocket.OPEN) safeSend(agentWs, rawMsg);
          }
        }
      } else if (msg.type === 'file:chunk') {
        const payload = msg.payload as FileChunkPayload;
        const rawMsg = raw.toString();
        this.transferManager.relayChunkMsg(payload.transferId, rawMsg, payload);
      } else if (msg.type === 'file:chunk-ack') {
        const payload = msg.payload as FileChunkAckPayload;
        const rawMsg = raw.toString();
        this.transferManager.relayAckMsg(payload.transferId, rawMsg, payload);
      } else if (msg.type === 'file:transfer-complete') {
        const { transferId } = msg.payload as { transferId: string };
        const rawMsg = raw.toString();
        this.transferManager.relayChunk(transferId, rawMsg);
        this.transferManager.completeTransfer(transferId);
      } else if (msg.type === 'file:transfer-error') {
        const { transferId, error } = msg.payload as { transferId: string; error: string };
        this.transferManager.errorTransfer(transferId, error);
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
      for (const [reqId, pending] of state.selfUpdatePending) {
        if (pending.cliSocket === ws) {
          clearTimeout(pending.timer);
          state.selfUpdatePending.delete(reqId);
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
    body: string,
    orgId?: string
  ): { status: 'delivered' | 'agent-offline' | 'unknown-agent' } {
    // Scope to specific org if provided, otherwise search default org only
    const searchOrgId = orgId ?? DEFAULT_ORG_ID;
    const state = this.orgStates.get(searchOrgId);
    if (!state) return { status: 'unknown-agent' };
    const targetSocket = state.agentSockets.get(toAgent);
    if (!targetSocket) return { status: 'unknown-agent' };
    if (targetSocket.readyState !== WebSocket.OPEN) return { status: 'agent-offline' };
    targetSocket.send(serializeMessage(createAgentMessage({ fromAgent, toAgent, correlationId, topic, body })));
    logger.info({ from: fromAgent, to: toAgent, correlationId, orgId: searchOrgId }, 'Agent message relayed');
    return { status: 'delivered' };
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
          allowedTools: task.allowedTools,
          disallowedTools: task.disallowedTools,
          addDirs: task.addDirs,
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
        const pool = this.requireStringArg(args, 'pool');
        let agentName = this.requireStringArg(args, 'agentName');
        const prompt = this.requireStringArg(args, 'prompt');

        // Resolve agent from pool when pool is provided instead of agentName
        if (pool) {
          const picked = state.registry.pickFromPool(pool);
          if (!picked) {
            this.sendError(ws, requestId, `No available agents in pool "${pool}"`);
            return;
          }
          agentName = picked.name;
        }

        if (!agentName || !prompt) {
          this.sendError(ws, requestId, 'Missing required arguments: agentName or pool, prompt');
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
        const taskAllowedTools = Array.isArray(args?.allowedTools) ? (args.allowedTools as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
        const taskDisallowedTools = Array.isArray(args?.disallowedTools) ? (args.disallowedTools as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
        const taskAddDirs = Array.isArray(args?.addDirs) ? (args.addDirs as unknown[]).filter((d): d is string => typeof d === 'string') : undefined;
        const task = this.tasks.create({ agentName, prompt, sessionId, traceId, ownerUserId: user.userId ?? undefined, orgId, allowedTools: taskAllowedTools?.length ? taskAllowedTools : undefined, disallowedTools: taskDisallowedTools?.length ? taskDisallowedTools : undefined, addDirs: taskAddDirs?.length ? taskAddDirs : undefined });
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
            data: { taskId: task.id, status: 'queued', queueDepth: state.queue.depth(), agentName },
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
            allowedTools: task.allowedTools,
            disallowedTools: task.disallowedTools,
            addDirs: task.addDirs,
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
          data: { taskId: task.id, status: 'dispatched', agentName },
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
      case 'send-message': {
        const fromAgent = this.requireStringArg(args, 'fromAgent');
        const toAgent = this.requireStringArg(args, 'toAgent');
        const topic = this.requireStringArg(args, 'topic');
        const body = this.requireStringArg(args, 'body');
        if (!fromAgent || !toAgent || !topic || !body) {
          this.sendError(ws, requestId, 'Missing required arguments: fromAgent, toAgent, topic, body');
          return;
        }
        const correlationId = randomUUID();
        const result = this.relayAgentMessageSync(fromAgent, toAgent, correlationId, topic, body);
        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { correlationId, status: result.status },
        })));
        break;
      }
      case 'push-file': {
        // CLI is pushing a file to an agent.
        // Args: agentName, destPath, filename, totalBytes, isDirectory, transferId?, exclude?
        const agentName = this.requireStringArg(args, 'agentName');
        const destPath = this.requireStringArg(args, 'destPath');
        const filename = this.requireStringArg(args, 'filename');
        if (!agentName || !destPath || !filename) {
          this.sendError(ws, requestId, 'Missing required arguments: agentName, destPath, filename');
          return;
        }
        const agentWs = state.agentSockets.get(agentName);
        if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
          this.sendError(ws, requestId, `Agent "${agentName}" not found or not reachable`);
          return;
        }
        const transferId = typeof args?.transferId === 'string' ? args.transferId : randomUUID();
        const totalBytes = typeof args?.totalBytes === 'number' ? args.totalBytes : 0;
        const isDirectory = args?.isDirectory === true;
        const totalChunks = typeof args?.totalChunks === 'number' ? args.totalChunks : 0;

        // Register transfer: CLI is source, agent is dest
        const startPayload: FileTransferStartPayload = {
          transferId,
          direction: 'push',
          filename,
          sourcePath: '',
          destPath,
          totalBytes,
          totalChunks,
          isDirectory,
          destAgent: agentName,
        };
        this.transferManager.startTransfer(transferId, startPayload, ws, agentWs);

        // Forward transfer-start to agent
        agentWs.send(serializeMessage(createFileTransferStart(startPayload)));

        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { transferId, ready: true },
        })));
        break;
      }
      case 'pull-file': {
        // CLI wants to pull a file from an agent.
        // Args: agentName, sourcePath, transferId?, exclude?
        const agentName = this.requireStringArg(args, 'agentName');
        const sourcePath = this.requireStringArg(args, 'sourcePath');
        if (!agentName || !sourcePath) {
          this.sendError(ws, requestId, 'Missing required arguments: agentName, sourcePath');
          return;
        }
        const agentWs = state.agentSockets.get(agentName);
        if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
          this.sendError(ws, requestId, `Agent "${agentName}" not found or not reachable`);
          return;
        }
        const transferId = typeof args?.transferId === 'string' ? args.transferId : randomUUID();
        const exclude = Array.isArray(args?.exclude) ? (args.exclude as unknown[]).filter((e): e is string => typeof e === 'string') : [];

        // Register transfer: agent is source, CLI is dest
        const pullMetadata: FileTransferStartPayload = {
          transferId,
          direction: 'pull',
          filename: sourcePath.split('/').pop() ?? sourcePath,
          sourcePath,
          destPath: '',
          totalBytes: 0,
          totalChunks: 0,
          isDirectory: false,
          sourceAgent: agentName,
        };
        this.transferManager.startTransfer(transferId, pullMetadata, agentWs, ws);

        // Tell agent to start sending
        agentWs.send(serializeMessage(createFilePullRequest({
          transferId,
          sourcePath,
          destAgent: agentName,
          exclude,
        })));

        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { transferId, ready: true },
        })));
        break;
      }
      case 'transfer-file': {
        // Agent-to-agent transfer.
        // Args: fromAgent, toAgent, sourcePath, destPath, transferId?, exclude?
        const fromAgent = this.requireStringArg(args, 'fromAgent');
        const toAgent = this.requireStringArg(args, 'toAgent');
        const sourcePath = this.requireStringArg(args, 'sourcePath');
        const destPath = this.requireStringArg(args, 'destPath');
        if (!fromAgent || !toAgent || !sourcePath || !destPath) {
          this.sendError(ws, requestId, 'Missing required arguments: fromAgent, toAgent, sourcePath, destPath');
          return;
        }
        const fromWs = state.agentSockets.get(fromAgent);
        const toWs = state.agentSockets.get(toAgent);
        if (!fromWs || fromWs.readyState !== WebSocket.OPEN) {
          this.sendError(ws, requestId, `Source agent "${fromAgent}" not found or not reachable`);
          return;
        }
        if (!toWs || toWs.readyState !== WebSocket.OPEN) {
          this.sendError(ws, requestId, `Destination agent "${toAgent}" not found or not reachable`);
          return;
        }
        const transferId = typeof args?.transferId === 'string' ? args.transferId : randomUUID();
        const exclude = Array.isArray(args?.exclude) ? (args.exclude as unknown[]).filter((e): e is string => typeof e === 'string') : [];

        // Register transfer: fromAgent is source, toAgent is dest
        const transferMetadata: FileTransferStartPayload = {
          transferId,
          direction: 'transfer',
          filename: sourcePath.split('/').pop() ?? sourcePath,
          sourcePath,
          destPath,
          totalBytes: 0,
          totalChunks: 0,
          isDirectory: false,
          sourceAgent: fromAgent,
          destAgent: toAgent,
        };
        this.transferManager.startTransfer(transferId, transferMetadata, fromWs, toWs);

        // Tell dest agent to prepare to receive
        toWs.send(serializeMessage(createFileTransferStart({
          ...transferMetadata,
          direction: 'transfer',
        })));

        // Tell source agent to start sending
        fromWs.send(serializeMessage(createFilePullRequest({
          transferId,
          sourcePath,
          destAgent: toAgent,
          exclude,
        })));

        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { transferId, status: 'initiated' },
        })));
        break;
      }
      case 'list-transfers': {
        const transfers = this.transferManager.getActiveTransfers();
        ws.send(serializeMessage(createCliResponse({
          requestId,
          data: { transfers },
        })));
        break;
      }
      case 'self-update': {
        const agentName = this.requireStringArg(args, 'agentName');
        if (!agentName) {
          this.sendError(ws, requestId, 'Missing required argument: agentName');
          return;
        }
        const agentWs = state.agentSockets.get(agentName);
        if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
          this.sendError(ws, requestId, `Agent "${agentName}" is not reachable`);
          return;
        }
        const timer = setTimeout(() => {
          const pending = state.selfUpdatePending.get(requestId);
          if (pending) {
            state.selfUpdatePending.delete(requestId);
            this.sendError(pending.cliSocket, pending.cliRequestId, 'Self-update request timed out');
          }
        }, 30000);
        state.selfUpdatePending.set(requestId, { cliSocket: ws, cliRequestId: requestId, timer });
        agentWs.send(serializeMessage(createAgentSelfUpdate({ requestId })));
        break;
      }
      default: {
        this.sendError(ws, requestId, `Unknown command: ${command}`);
      }
    }
  }
}
