import WebSocket from 'ws';
import { platform, arch } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Executor } from './executor.js';
import { checkClaudeHealth } from './health.js';
import { logger } from '../shared/logger.js';
import {
  parseMessage,
  serializeMessage,
  createAgentRegister,
  createAgentHeartbeat,
  createTaskOutput,
  createTaskComplete,
  createTaskError,
  createSessionListResponse,
  type SessionInfo,
} from '../protocol/messages.js';

const execFileAsync = promisify(execFile);

export interface AgentDaemonOptions {
  name: string;
  coordinatorUrl: string;
  token: string;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  workingDirectory?: string;
  taskTimeoutMs?: number;
  dangerouslySkipPermissions?: boolean;
  maxConcurrent?: number;
}

export class AgentDaemon {
  private ws: WebSocket | null = null;
  private executor = new Executor();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private stopped = false;
  private options: AgentDaemonOptions;
  private lastHealth: { claudeAvailable: boolean; version?: string } = { claudeAvailable: false };
  private runningTaskCount = 0;

  constructor(options: AgentDaemonOptions) {
    this.options = options;
    this.reconnectDelay = options.reconnectDelayMs ?? 1000;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const health = await checkClaudeHealth();
    this.lastHealth = { claudeAvailable: health.available, version: health.version };
    logger.info({ health: this.lastHealth }, 'Initial health check');

    await this.connect();

    // Start health check timer only after successful connection
    this.healthCheckTimer = setInterval(async () => {
      const h = await checkClaudeHealth();
      this.lastHealth = { claudeAvailable: h.available, version: h.version };
    }, 300000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.executor.kill();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): Promise<void> {
    // Clear any existing heartbeat timer to prevent leaks on reconnect
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    return new Promise((resolve, reject) => {
      const url = `${this.options.coordinatorUrl}/agent`;
      this.ws = new WebSocket(url, { headers: { 'authorization': `Bearer ${this.options.token}` } });

      this.ws.on('open', () => {
        logger.info({ coordinator: this.options.coordinatorUrl, name: this.options.name }, 'Agent connected');
        this.reconnectDelay = this.options.reconnectDelayMs ?? 1000;

        this.ws!.send(serializeMessage(createAgentRegister({
          name: this.options.name,
          os: platform(),
          arch: arch(),
          maxConcurrent: this.options.maxConcurrent,
          health: this.lastHealth,
        })));

        const interval = this.options.heartbeatIntervalMs ?? 30000;
        this.heartbeatTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(serializeMessage(createAgentHeartbeat({
              name: this.options.name,
              health: this.lastHealth,
            })));
          }
        }, interval);

        resolve();
      });

      this.ws.on('message', (raw) => {
        const msg = parseMessage(raw.toString());
        if (!msg) return;

        if (msg.type === 'task:dispatch') {
          const { taskId, prompt, sessionId, traceId, maxBudgetUsd } = msg.payload as any;

          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!taskId || !uuidRegex.test(taskId)) {
            return;
          }

          const localMax = this.options.maxConcurrent ?? 1;
          if (this.runningTaskCount >= localMax) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(serializeMessage(createTaskError({
                taskId,
                error: `Agent at local capacity (${this.runningTaskCount}/${localMax})`,
              })));
            }
            return;
          }

          if (!prompt || typeof prompt !== 'string' || prompt.length > 1_000_000) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(serializeMessage(createTaskError({
                taskId: taskId ?? 'unknown',
                error: 'Invalid or oversized prompt',
              })));
            }
            return;
          }

          if (sessionId && !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(serializeMessage(createTaskError({
                taskId,
                error: 'Invalid sessionId format',
              })));
            }
            return;
          }

          logger.info({ taskId, traceId }, 'Task received');
          this.runningTaskCount++;
          this.handleTask(taskId, prompt, sessionId, traceId, maxBudgetUsd).finally(() => {
            this.runningTaskCount--;
          });
        } else if (msg.type === 'session:list-request') {
          const { agentName, requestId } = msg.payload as { agentName: string; requestId: string };
          this.handleSessionListRequest(agentName, requestId);
        }
      });

      this.ws.on('close', () => {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        if (this.ws?.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    const maxDelay = this.options.maxReconnectDelayMs ?? 30000;
    logger.info({ delay: this.reconnectDelay }, 'Scheduling reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Reconnect failed');
      });
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, maxDelay);
  }

  private async handleSessionListRequest(agentName: string, requestId: string): Promise<void> {
    logger.info({ agentName }, 'Session list requested');
    try {
      const { stdout } = await execFileAsync('claude', ['sessions', 'list', '--output', 'json'], {
        timeout: 15000,
      });
      let sessions: SessionInfo[] = [];
      try {
        const parsed = JSON.parse(stdout.trim());
        if (Array.isArray(parsed)) {
          sessions = parsed.map((s: Record<string, unknown>) => ({
            id: String(s['id'] ?? ''),
            name: typeof s['name'] === 'string' ? s['name'] : undefined,
            createdAt: typeof s['createdAt'] === 'string' ? s['createdAt'] : undefined,
          }));
        }
      } catch {
        // stdout wasn't JSON — treat as empty list
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(serializeMessage(createSessionListResponse({
          agentName,
          sessions,
          requestId,
        })));
      }
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Session list command failed');
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(serializeMessage(createSessionListResponse({
          agentName,
          sessions: [],
          requestId,
          error: err instanceof Error ? err.message : String(err),
        })));
      }
    }
  }

  private async handleTask(taskId: string, prompt: string, sessionId: string | undefined, traceId?: string, maxBudgetUsd?: number): Promise<void> {
    const stderrChunks: string[] = [];
    const MAX_STDERR_BYTES = 1024 * 1024; // 1MB cap
    let stderrBytes = 0;
    try {
      const result = await this.executor.run({
        prompt,
        taskId,
        sessionId,
        workingDirectory: this.options.workingDirectory,
        timeoutMs: this.options.taskTimeoutMs,
        dangerouslySkipPermissions: this.options.dangerouslySkipPermissions,
        maxBudgetUsd,
        onOutput: (data) => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(serializeMessage(createTaskOutput({ taskId, data, traceId })));
          }
        },
        onError: (data) => {
          stderrBytes += Buffer.byteLength(data);
          if (stderrBytes <= MAX_STDERR_BYTES) {
            stderrChunks.push(data);
          }
        },
      });

      logger.info({ taskId, exitCode: result.exitCode, timedOut: result.timedOut }, 'Task finished');
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (result.exitCode === 0) {
          this.ws.send(serializeMessage(createTaskComplete({ taskId, traceId })));
        } else {
          const stderr = stderrChunks.join('').trim();
          let errorMsg: string;
          if (result.timedOut) {
            errorMsg = `Task timed out after ${(this.options.taskTimeoutMs ?? 1800000) / 1000}s`;
          } else {
            errorMsg = stderr
              ? `Claude exited with code ${result.exitCode}: ${stderr}`
              : `Claude exited with code ${result.exitCode}`;
          }
          this.ws.send(serializeMessage(createTaskError({
            taskId,
            error: errorMsg,
            traceId,
          })));
        }
      }
    } catch (err) {
      logger.error({ taskId, traceId, error: err instanceof Error ? err.message : String(err) }, 'Task execution failed');
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(serializeMessage(createTaskError({
          taskId,
          error: err instanceof Error ? err.message : String(err),
          traceId,
        })));
      }
    }
  }
}
