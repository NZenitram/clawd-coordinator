import WebSocket from 'ws';
import { platform, arch } from 'node:os';
import { Executor } from './executor.js';
import { logger } from '../shared/logger.js';
import {
  parseMessage,
  serializeMessage,
  createAgentRegister,
  createAgentHeartbeat,
  createTaskOutput,
  createTaskComplete,
  createTaskError,
} from '../protocol/messages.js';

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
}

export class AgentDaemon {
  private ws: WebSocket | null = null;
  private executor = new Executor();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private stopped = false;
  private options: AgentDaemonOptions;

  constructor(options: AgentDaemonOptions) {
    this.options = options;
    this.reconnectDelay = options.reconnectDelayMs ?? 1000;
  }

  async start(): Promise<void> {
    this.stopped = false;
    return this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
        })));

        const interval = this.options.heartbeatIntervalMs ?? 30000;
        this.heartbeatTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(serializeMessage(createAgentHeartbeat({
              name: this.options.name,
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
          this.handleTask(taskId, prompt, sessionId, traceId, maxBudgetUsd);
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
      this.connect().catch(() => {});
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, maxDelay);
  }

  private async handleTask(taskId: string, prompt: string, sessionId: string | undefined, traceId?: string, maxBudgetUsd?: number): Promise<void> {
    const stderrChunks: string[] = [];
    try {
      const result = await this.executor.run({
        prompt,
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
          stderrChunks.push(data);
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
