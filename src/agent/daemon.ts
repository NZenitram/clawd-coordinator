import WebSocket from 'ws';
import { platform, arch } from 'node:os';
import { Executor } from './executor.js';
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
      const url = `${this.options.coordinatorUrl}/agent?token=${this.options.token}`;
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
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
          this.handleTask(msg.payload.taskId, msg.payload.prompt, msg.payload.sessionId);
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
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {});
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, maxDelay);
  }

  private async handleTask(taskId: string, prompt: string, sessionId: string | undefined): Promise<void> {
    const stderrChunks: string[] = [];
    try {
      const result = await this.executor.run({
        prompt,
        sessionId,
        workingDirectory: this.options.workingDirectory,
        timeoutMs: this.options.taskTimeoutMs,
        onOutput: (data) => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(serializeMessage(createTaskOutput({ taskId, data })));
          }
        },
        onError: (data) => {
          stderrChunks.push(data);
        },
      });

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (result.exitCode === 0) {
          this.ws.send(serializeMessage(createTaskComplete({ taskId })));
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
          })));
        }
      }
    } catch (err) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(serializeMessage(createTaskError({
          taskId,
          error: err instanceof Error ? err.message : String(err),
        })));
      }
    }
  }
}
