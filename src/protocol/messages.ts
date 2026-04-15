import { randomUUID } from 'node:crypto';

// --- Message envelope ---

export interface Message<T extends string, P> {
  id: string;
  type: T;
  version: number;
  timestamp: number;
  payload: P;
}

// --- Payload types ---

export interface AgentHealthPayload {
  claudeAvailable: boolean;
  version?: string;
}

export interface AgentRegisterPayload {
  name: string;
  os: string;
  arch: string;
  maxConcurrent?: number;
  health?: AgentHealthPayload;
  allowedTools?: string[];
  addDirs?: string[];
  permissionMode?: string;
}

export interface AgentHeartbeatPayload {
  name: string;
  health?: AgentHealthPayload;
}

export interface TaskDispatchPayload {
  taskId: string;
  prompt: string;
  sessionId: string | undefined;
  traceId?: string;
  maxBudgetUsd?: number;
  retryAttempt?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
}

export interface AgentMessagePayload {
  fromAgent: string;
  toAgent: string;
  correlationId: string;
  topic: string;
  body: string;
}

export interface AgentMessageReplyPayload {
  fromAgent: string;
  toAgent: string;
  correlationId: string;
  body: string;
}

export interface AgentMessageAckPayload {
  correlationId: string;
  status: 'delivered' | 'agent-offline' | 'unknown-agent';
}

export interface TaskOutputPayload {
  taskId: string;
  data: string;
  traceId?: string;
}

export interface TaskCompletePayload {
  taskId: string;
  traceId?: string;
}

export interface TaskErrorPayload {
  taskId: string;
  error: string;
  traceId?: string;
}

export interface CliRequestPayload {
  command: string;
  args?: Record<string, unknown>;
}

export interface CliResponsePayload {
  requestId: string;
  data: unknown;
  error?: string;
}

export interface SessionInfo {
  id: string;
  name?: string;
  createdAt?: string;
}

export interface SessionListRequestPayload {
  agentName: string;
  /** correlates request to response across the coordinator relay */
  requestId: string;
}

export interface SessionListResponsePayload {
  agentName: string;
  sessions: SessionInfo[];
  requestId: string;
  error?: string;
}

// --- File transfer payload types ---

export interface FileTransferStartPayload {
  transferId: string;
  direction: 'push' | 'pull' | 'transfer';
  filename: string;
  sourcePath: string;
  destPath: string;
  totalBytes: number;
  totalChunks: number;
  isDirectory: boolean;
  sourceAgent?: string;
  destAgent?: string;
}

export interface FileChunkPayload {
  transferId: string;
  chunkIndex: number;
  data: string; // base64-encoded binary data
}

export interface FileChunkAckPayload {
  transferId: string;
  chunkIndex: number;
}

export interface FileTransferCompletePayload {
  transferId: string;
  checksum?: string; // optional SHA-256
}

export interface FileTransferErrorPayload {
  transferId: string;
  error: string;
}

export interface FilePullRequestPayload {
  transferId: string;
  sourcePath: string;
  destAgent: string;
  exclude?: string[];
}

// --- Self-update payload types ---

export interface AgentSelfUpdatePayload {
  requestId: string;
}

export interface AgentSelfUpdateResponsePayload {
  requestId: string;
  success: boolean;
  message: string;
  oldVersion?: string;
  newVersion?: string;
}

// --- Concrete message types ---

export type AgentRegister = Message<'agent:register', AgentRegisterPayload>;
export type AgentHeartbeat = Message<'agent:heartbeat', AgentHeartbeatPayload>;
export type TaskDispatch = Message<'task:dispatch', TaskDispatchPayload>;
export type TaskOutput = Message<'task:output', TaskOutputPayload>;
export type TaskComplete = Message<'task:complete', TaskCompletePayload>;
export type TaskError = Message<'task:error', TaskErrorPayload>;
export type CliRequest = Message<'cli:request', CliRequestPayload>;
export type CliResponse = Message<'cli:response', CliResponsePayload>;
export type SessionListRequest = Message<'session:list-request', SessionListRequestPayload>;
export type SessionListResponse = Message<'session:list-response', SessionListResponsePayload>;
export type AgentMessage = Message<'agent:message', AgentMessagePayload>;
export type AgentMessageReply = Message<'agent:message-reply', AgentMessageReplyPayload>;
export type AgentMessageAck = Message<'agent:message-ack', AgentMessageAckPayload>;

// --- File transfer message types ---
export type FileTransferStart = Message<'file:transfer-start', FileTransferStartPayload>;
export type FileChunk = Message<'file:chunk', FileChunkPayload>;
export type FileChunkAck = Message<'file:chunk-ack', FileChunkAckPayload>;
export type FileTransferComplete = Message<'file:transfer-complete', FileTransferCompletePayload>;
export type FileTransferError = Message<'file:transfer-error', FileTransferErrorPayload>;
export type FilePullRequest = Message<'file:pull-request', FilePullRequestPayload>;
export type AgentSelfUpdate = Message<'agent:self-update', AgentSelfUpdatePayload>;
export type AgentSelfUpdateResponse = Message<'agent:self-update-response', AgentSelfUpdateResponsePayload>;

export type AnyMessage =
  | AgentRegister
  | AgentHeartbeat
  | TaskDispatch
  | TaskOutput
  | TaskComplete
  | TaskError
  | CliRequest
  | CliResponse
  | SessionListRequest
  | SessionListResponse
  | AgentMessage
  | AgentMessageReply
  | AgentMessageAck
  | FileTransferStart
  | FileChunk
  | FileChunkAck
  | FileTransferComplete
  | FileTransferError
  | FilePullRequest
  | AgentSelfUpdate
  | AgentSelfUpdateResponse;

// --- Factory functions ---

function makeMessage<T extends string, P>(type: T, payload: P): Message<T, P> {
  return {
    id: randomUUID(),
    type,
    version: 1,
    timestamp: Date.now(),
    payload,
  };
}

export function createAgentRegister(payload: AgentRegisterPayload): AgentRegister {
  return makeMessage('agent:register', payload);
}

export function createAgentHeartbeat(payload: AgentHeartbeatPayload): AgentHeartbeat {
  return makeMessage('agent:heartbeat', payload);
}

export function createTaskDispatch(payload: TaskDispatchPayload): TaskDispatch {
  return makeMessage('task:dispatch', payload);
}

export function createTaskOutput(payload: TaskOutputPayload): TaskOutput {
  return makeMessage('task:output', payload);
}

export function createTaskComplete(payload: TaskCompletePayload): TaskComplete {
  return makeMessage('task:complete', payload);
}

export function createTaskError(payload: TaskErrorPayload): TaskError {
  return makeMessage('task:error', payload);
}

export function createCliRequest(payload: CliRequestPayload): CliRequest {
  return makeMessage('cli:request', payload);
}

export function createCliResponse(payload: CliResponsePayload): CliResponse {
  return makeMessage('cli:response', payload);
}

export function createSessionListRequest(payload: SessionListRequestPayload): SessionListRequest {
  return makeMessage('session:list-request', payload);
}

export function createSessionListResponse(payload: SessionListResponsePayload): SessionListResponse {
  return makeMessage('session:list-response', payload);
}

export function createAgentMessage(payload: AgentMessagePayload): AgentMessage {
  return makeMessage('agent:message', payload);
}

export function createAgentMessageReply(payload: AgentMessageReplyPayload): AgentMessageReply {
  return makeMessage('agent:message-reply', payload);
}

export function createAgentMessageAck(payload: AgentMessageAckPayload): AgentMessageAck {
  return makeMessage('agent:message-ack', payload);
}

// --- File transfer factory functions ---

export function createFileTransferStart(payload: FileTransferStartPayload): FileTransferStart {
  return makeMessage('file:transfer-start', payload);
}

export function createFileChunk(payload: FileChunkPayload): FileChunk {
  return makeMessage('file:chunk', payload);
}

export function createFileChunkAck(payload: FileChunkAckPayload): FileChunkAck {
  return makeMessage('file:chunk-ack', payload);
}

export function createFileTransferComplete(payload: FileTransferCompletePayload): FileTransferComplete {
  return makeMessage('file:transfer-complete', payload);
}

export function createFileTransferError(payload: FileTransferErrorPayload): FileTransferError {
  return makeMessage('file:transfer-error', payload);
}

export function createFilePullRequest(payload: FilePullRequestPayload): FilePullRequest {
  return makeMessage('file:pull-request', payload);
}

export function createAgentSelfUpdate(payload: AgentSelfUpdatePayload): AgentSelfUpdate {
  return makeMessage('agent:self-update', payload);
}

export function createAgentSelfUpdateResponse(payload: AgentSelfUpdateResponsePayload): AgentSelfUpdateResponse {
  return makeMessage('agent:self-update-response', payload);
}

// --- Serialization ---

export function serializeMessage(msg: AnyMessage): string {
  return JSON.stringify(msg);
}

// --- Message deduplication ---

export class MessageDeduplicator {
  private seen = new Set<string>();
  private maxSize: number;

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  isDuplicate(messageId: string): boolean {
    if (this.seen.has(messageId)) return true;
    this.seen.add(messageId);
    if (this.seen.size > this.maxSize) {
      const iter = this.seen.values();
      for (let i = 0; i < this.maxSize / 2; i++) {
        this.seen.delete(iter.next().value!);
      }
    }
    return false;
  }
}

const VALID_TYPES = new Set([
  'agent:register', 'agent:heartbeat',
  'task:dispatch', 'task:output', 'task:complete', 'task:error',
  'cli:request', 'cli:response',
  'session:list-request', 'session:list-response',
  'agent:message', 'agent:message-reply', 'agent:message-ack',
  'file:transfer-start', 'file:chunk', 'file:chunk-ack',
  'file:transfer-complete', 'file:transfer-error', 'file:pull-request',
  'agent:self-update', 'agent:self-update-response',
]);

export function parseMessage(raw: string): AnyMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.id !== 'string') return null;
    if (typeof parsed.type !== 'string' || !VALID_TYPES.has(parsed.type)) return null;
    if (parsed.version !== undefined && typeof parsed.version !== 'number') return null;
    if (typeof parsed.timestamp !== 'number') return null;
    if (typeof parsed.payload !== 'object' || parsed.payload === null) return null;
    return parsed as AnyMessage;
  } catch {
    return null;
  }
}
