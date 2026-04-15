import WebSocket from 'ws';
import { platform, arch } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Executor } from './executor.js';
import { checkClaudeHealth } from './health.js';
import { createIsolationStrategy, WorktreeStrategy, type IsolationMode, type IsolationStrategy } from './isolation.js';
import { FileSender, FileReceiver, isPathAllowed } from './file-handler.js';
import { logger } from '../shared/logger.js';
import { safeSend } from '../shared/ws-utils.js';
import {
  parseMessage,
  serializeMessage,
  createAgentRegister,
  createAgentHeartbeat,
  createTaskOutput,
  createTaskComplete,
  createTaskError,
  createSessionListResponse,
  createAgentSelfUpdateResponse,
  createFileTransferStart,
  createFileChunkAck,
  createFileTransferError,
  type SessionInfo,
  type FileTransferStartPayload,
  type FileChunkPayload,
  type FileChunkAckPayload,
  type FileTransferCompletePayload,
  type FilePullRequestPayload,
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
  isolation?: IsolationMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  permissionMode?: string;
  pool?: string;
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
  private isolationStrategy: IsolationStrategy;
  private fileSender = new FileSender();
  private fileReceiver = new FileReceiver();

  constructor(options: AgentDaemonOptions) {
    this.options = options;
    this.reconnectDelay = options.reconnectDelayMs ?? 1000;
    this.isolationStrategy = createIsolationStrategy(options.isolation ?? 'none');
  }

  async start(): Promise<void> {
    this.stopped = false;
    const health = await checkClaudeHealth();
    this.lastHealth = { claudeAvailable: health.available, version: health.version };
    logger.info({ health: this.lastHealth }, 'Initial health check');

    if (this.options.isolation === 'worktree') {
      const workingDir = this.options.workingDirectory ?? process.cwd();
      await WorktreeStrategy.pruneOrphans(workingDir);
    }

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
    this.fileReceiver.cleanupAll();
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

        // Read package version for drift detection
        let coordVersion = 'unknown';
        try {
          const packageDir = path.resolve(path.dirname(process.argv[1]), '..', '..');
          const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf-8'));
          coordVersion = pkg.version ?? 'unknown';
        } catch { /* non-fatal */ }

        this.ws!.send(serializeMessage(createAgentRegister({
          name: this.options.name,
          os: platform(),
          arch: arch(),
          coordVersion,
          maxConcurrent: this.options.maxConcurrent,
          health: this.lastHealth,
          allowedTools: this.options.allowedTools,
          addDirs: this.options.addDirs,
          permissionMode: this.options.permissionMode,
          pool: this.options.pool,
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
          const taskPayload = msg.payload as any;

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

          // Compute effective permissions (only when not dangerouslySkipPermissions)
          let effectiveAllowedTools: string[] | undefined;
          let effectiveDisallowedTools: string[] | undefined;
          let effectiveAddDirs: string[] | undefined;
          let effectivePermissionMode: string | undefined;

          if (!this.options.dangerouslySkipPermissions) {
            const taskAllowedTools: string[] = Array.isArray(taskPayload.allowedTools)
              ? (taskPayload.allowedTools as unknown[]).filter((t): t is string => typeof t === 'string')
              : [];
            const taskDisallowedTools: string[] = Array.isArray(taskPayload.disallowedTools)
              ? (taskPayload.disallowedTools as unknown[]).filter((t): t is string => typeof t === 'string')
              : [];
            const taskAddDirs: string[] = Array.isArray(taskPayload.addDirs)
              ? (taskPayload.addDirs as unknown[]).filter((d): d is string => typeof d === 'string')
              : [];

            const agentAllowedTools = this.options.allowedTools;
            const agentDisallowedTools = this.options.disallowedTools ?? [];
            const agentAddDirs = this.options.addDirs;

            // allowedTools: intersection — task can only restrict, not expand agent-level
            if (agentAllowedTools !== undefined) {
              const agentSet = new Set(agentAllowedTools);
              effectiveAllowedTools = taskAllowedTools.length > 0
                ? taskAllowedTools.filter(t => agentSet.has(t))
                : agentAllowedTools;
            } else if (taskAllowedTools.length > 0) {
              effectiveAllowedTools = taskAllowedTools;
            }

            // disallowedTools: union — more restrictive wins
            const disallowedUnion = new Set([...agentDisallowedTools, ...taskDisallowedTools]);
            effectiveDisallowedTools = disallowedUnion.size > 0 ? Array.from(disallowedUnion) : undefined;

            // addDirs: task-level must be subpaths of agent-level dirs (or agent-level if no task override)
            if (agentAddDirs !== undefined) {
              if (taskAddDirs.length > 0) {
                effectiveAddDirs = taskAddDirs.filter(taskDir =>
                  agentAddDirs.some(agentDir => taskDir === agentDir || taskDir.startsWith(agentDir + '/'))
                );
                if (effectiveAddDirs.length === 0) effectiveAddDirs = undefined;
              } else {
                effectiveAddDirs = agentAddDirs;
              }
            } else if (taskAddDirs.length > 0) {
              effectiveAddDirs = taskAddDirs;
            }

            // permissionMode: agent-level takes precedence; task cannot override
            effectivePermissionMode = this.options.permissionMode;
          }

          logger.info({ taskId, traceId }, 'Task received');
          this.runningTaskCount++;
          this.handleTask(taskId, prompt, sessionId, traceId, maxBudgetUsd, effectiveAllowedTools, effectiveDisallowedTools, effectiveAddDirs, effectivePermissionMode).finally(() => {
            this.runningTaskCount--;
          });
        } else if (msg.type === 'session:list-request') {
          const { agentName, requestId } = msg.payload as { agentName: string; requestId: string };
          this.handleSessionListRequest(agentName, requestId);
        } else if (msg.type === 'agent:message') {
          const { fromAgent, correlationId, topic, body } = msg.payload;
          logger.info({ from: fromAgent, correlationId, topic }, 'Received agent message');
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(serializeMessage(createTaskOutput({
              taskId: correlationId,
              data: `[agent-message] from=${fromAgent} topic=${topic}: ${body}`,
            })));
          }
        } else if (msg.type === 'agent:message-reply') {
          const { fromAgent, correlationId, body } = msg.payload;
          logger.info({ from: fromAgent, correlationId }, 'Received agent message-reply');
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(serializeMessage(createTaskOutput({
              taskId: correlationId,
              data: `[agent-message-reply] from=${fromAgent}: ${body}`,
            })));
          }
        } else if (msg.type === 'file:pull-request') {
          this.handleFilePullRequest(msg.payload as FilePullRequestPayload).catch((err) => {
            logger.error({ error: err instanceof Error ? err.message : String(err) }, 'File pull-request failed');
          });
        } else if (msg.type === 'file:transfer-start') {
          const payload = msg.payload as FileTransferStartPayload;
          this.handleFileTransferStart(payload).catch((err) => {
            logger.error({ transferId: payload.transferId, error: err instanceof Error ? err.message : String(err) }, 'File transfer-start failed');
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(serializeMessage(createFileTransferError({
                transferId: payload.transferId,
                error: err instanceof Error ? err.message : String(err),
              })));
            }
          });
        } else if (msg.type === 'file:chunk') {
          const payload = msg.payload as FileChunkPayload;
          const ack = this.fileReceiver.handleChunk(payload);
          if (ack && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(serializeMessage(createFileChunkAck(ack)));
          }
        } else if (msg.type === 'file:chunk-ack') {
          this.fileSender.handleAck(msg.payload as FileChunkAckPayload);
        } else if (msg.type === 'file:transfer-complete') {
          const payload = msg.payload as FileTransferCompletePayload;
          this.fileReceiver.handleComplete(payload);
        } else if (msg.type === 'file:transfer-error') {
          const { transferId, error } = msg.payload as { transferId: string; error: string };
          this.fileReceiver.handleError(transferId, error);
        } else if (msg.type === 'agent:self-update') {
          const { requestId } = msg.payload;
          this.handleSelfUpdate(requestId).catch((err) => {
            logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Self-update handler error');
          });
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

  private async handleFilePullRequest(payload: FilePullRequestPayload): Promise<void> {
    const { transferId, sourcePath } = payload;
    const cwd = this.options.workingDirectory ?? process.cwd();
    const addDirs = this.options.addDirs ?? [];

    if (!isPathAllowed(sourcePath, cwd, addDirs)) {
      logger.warn({ transferId, sourcePath }, 'File pull-request rejected: path not allowed');
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(serializeMessage(createFileTransferError({
          transferId,
          error: `Path not allowed: ${sourcePath}`,
        })));
      }
      return;
    }

    logger.info({ transferId, sourcePath }, 'Starting file send (pull-request)');
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    await this.fileSender.send(this.ws, transferId, sourcePath);
  }

  private async handleFileTransferStart(payload: FileTransferStartPayload): Promise<void> {
    const { transferId, destPath } = payload;
    const cwd = this.options.workingDirectory ?? process.cwd();
    const addDirs = this.options.addDirs ?? [];

    if (!isPathAllowed(destPath, cwd, addDirs)) {
      logger.warn({ transferId, destPath }, 'File transfer-start rejected: dest path not allowed');
      throw new Error(`Destination path not allowed: ${destPath}`);
    }

    logger.info({ transferId, destPath, isDirectory: payload.isDirectory }, 'Starting file receive');
    // Start receiver (non-blocking — chunks will drive it)
    this.fileReceiver.startReceive(transferId, destPath, payload).catch((err) => {
      logger.error({ transferId, error: err instanceof Error ? err.message : String(err) }, 'File receive failed');
    });

    // Send initial ack to unblock the sender
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serializeMessage(createFileChunkAck({ transferId, chunkIndex: -1 })));
    }
  }

  private async handleSelfUpdate(requestId: string): Promise<void> {
    // Resolve the package root from the running script location:
    // process.argv[1] is something like /path/to/clawd-coordinator/dist/cli/index.js
    // Two levels up from dist/cli/index.js gives the project root.
    const packageDir = path.resolve(path.dirname(process.argv[1]), '..', '..');

    const sendResponse = (payload: Parameters<typeof createAgentSelfUpdateResponse>[0]): void => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(serializeMessage(createAgentSelfUpdateResponse(payload)));
      }
    };

    let oldVersion = '';
    let newVersion = '';

    try {
      // Get current version before update
      try {
        const { stdout } = await execFileAsync(process.execPath, [
          path.join(packageDir, 'dist', 'cli', 'index.js'), '--version',
        ], { cwd: packageDir, timeout: 10000 });
        oldVersion = stdout.trim();
      } catch {
        // Non-fatal — version detection failure should not block the update
        oldVersion = 'unknown';
      }

      // git pull
      logger.info({ packageDir }, 'Self-update: git pull');
      await execFileAsync('git', ['pull'], { cwd: packageDir, timeout: 30000 });

      // npm install
      logger.info({ packageDir }, 'Self-update: npm install');
      await execFileAsync('npm', ['install'], { cwd: packageDir, timeout: 120000 });

      // npm run build
      logger.info({ packageDir }, 'Self-update: npm run build');
      await execFileAsync('npm', ['run', 'build'], { cwd: packageDir, timeout: 60000 });

      // Get new version after build
      try {
        const { stdout } = await execFileAsync(process.execPath, [
          path.join(packageDir, 'dist', 'cli', 'index.js'), '--version',
        ], { cwd: packageDir, timeout: 10000 });
        newVersion = stdout.trim();
      } catch {
        newVersion = 'unknown';
      }

      sendResponse({
        requestId,
        success: true,
        message: 'Update complete. Restarting...',
        oldVersion,
        newVersion,
      });

      logger.info({ oldVersion, newVersion }, 'Self-update complete — scheduling restart');

      // Re-exec with same args after a short delay so the response can be delivered
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: 'ignore',
          cwd: process.cwd(),
          env: process.env,
        });
        child.unref();
        process.exit(0);
      }, 1000);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'Self-update failed');
      sendResponse({
        requestId,
        success: false,
        message,
      });
    }
  }

  private async handleTask(taskId: string, prompt: string, sessionId: string | undefined, traceId?: string, maxBudgetUsd?: number, allowedTools?: string[], disallowedTools?: string[], addDirs?: string[], permissionMode?: string): Promise<void> {
    const stderrChunks: string[] = [];
    const MAX_STDERR_BYTES = 1024 * 1024; // 1MB cap
    let stderrBytes = 0;
    const baseDir = this.options.workingDirectory ?? process.cwd();
    let workingDirectory: string;
    try {
      workingDirectory = await this.isolationStrategy.setup(taskId, baseDir);
    } catch (err) {
      logger.error({ taskId, traceId, error: err instanceof Error ? err.message : String(err) }, 'Isolation setup failed');
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(serializeMessage(createTaskError({
          taskId,
          error: `Isolation setup failed: ${err instanceof Error ? err.message : String(err)}`,
          traceId,
        })));
      }
      return;
    }
    try {
      const result = await this.executor.run({
        prompt,
        taskId,
        sessionId,
        workingDirectory,
        timeoutMs: this.options.taskTimeoutMs,
        dangerouslySkipPermissions: this.options.dangerouslySkipPermissions,
        maxBudgetUsd,
        allowedTools,
        disallowedTools,
        addDirs,
        permissionMode,
        onOutput: (data) => {
          if (this.ws) {
            safeSend(this.ws, serializeMessage(createTaskOutput({ taskId, data, traceId })));
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
    } finally {
      await this.isolationStrategy.cleanup(taskId).catch((err) => {
        logger.warn({ taskId, error: err instanceof Error ? err.message : String(err) }, 'Isolation cleanup failed');
      });
    }
  }
}
