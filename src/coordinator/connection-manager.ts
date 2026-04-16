import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../shared/logger.js';
import { getMeta, setMeta } from './typed-socket.js';
import type { OrgState } from './org-state.js';
import type { TaskStore } from './tasks.js';

export interface ConnectionManagerOptions {
  stalenessThresholdMs?: number;
  stalenessCheckIntervalMs?: number;
  taskCleanupMaxAgeMs?: number;
  onTaskFailure: (taskId: string, agentName: string, error: string, state: OrgState) => void;
}

export class ConnectionManager {
  private ipConnectionCounts = new Map<string, number>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stalenessTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private wss: WebSocketServer | null = null;
  private orgStates: Map<string, OrgState>;
  private tasks: TaskStore;
  private options: ConnectionManagerOptions;

  constructor(
    orgStates: Map<string, OrgState>,
    tasks: TaskStore,
    options: ConnectionManagerOptions,
  ) {
    this.orgStates = orgStates;
    this.tasks = tasks;
    this.options = options;
  }

  /** Attach to the running WebSocketServer and start all timers. */
  start(wss: WebSocketServer): void {
    this.wss = wss;
    this.startPing();
    this.startStalenessCheck();
    this.startCleanup();
  }

  stop(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.stalenessTimer) { clearInterval(this.stalenessTimer); this.stalenessTimer = null; }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }

  /** Track a new connection from the given IP. Returns the cleanup function. */
  trackIp(ip: string, ws: WebSocket): () => void {
    this.ipConnectionCounts.set(ip, (this.ipConnectionCounts.get(ip) ?? 0) + 1);
    return () => {
      const current = this.ipConnectionCounts.get(ip) ?? 1;
      if (current <= 1) {
        this.ipConnectionCounts.delete(ip);
      } else {
        this.ipConnectionCounts.set(ip, current - 1);
      }
    };
  }

  getIpCount(ip: string): number {
    return this.ipConnectionCounts.get(ip) ?? 0;
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (!this.wss) return;
      for (const client of this.wss.clients) {
        if (getMeta(client).isAlive === false) {
          client.terminate();
          continue;
        }
        setMeta(client, { isAlive: false });
        client.ping();
      }
    }, 30000);
  }

  private startStalenessCheck(): void {
    const stalenessThreshold = this.options.stalenessThresholdMs ?? 90000;
    const stalenessInterval = this.options.stalenessCheckIntervalMs ?? 30000;

    this.stalenessTimer = setInterval(() => {
      for (const [oid, state] of this.orgStates) {
        const stale = state.registry.getStaleAgents(stalenessThreshold);
        for (const agent of stale) {
          const socket = state.agentSockets.get(agent.name);
          if (socket) socket.close(4002, 'Stale agent');
          logger.info({ agent: agent.name, orgId: oid }, 'Stale agent evicted');
          state.registry.unregister(agent.name);
          state.agentSockets.delete(agent.name);
        }
        const deadBusy = state.registry.getDeadBusyAgents(300000); // 5 min
        for (const agent of deadBusy) {
          for (const taskId of [...agent.currentTaskIds]) {
            this.options.onTaskFailure(taskId, agent.name, 'Agent became unresponsive', state);
          }
          const socket = state.agentSockets.get(agent.name);
          if (socket) socket.close(4002, 'Unresponsive busy agent');
          logger.info({ agent: agent.name, orgId: oid }, 'Dead busy agent evicted');
          state.registry.unregister(agent.name);
          state.agentSockets.delete(agent.name);
        }
      }
    }, stalenessInterval);
  }

  private startCleanup(): void {
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
  }
}
