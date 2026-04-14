import { randomUUID } from 'node:crypto';

// --- Message envelope ---

export interface Message<T extends string, P> {
  id: string;
  type: T;
  timestamp: number;
  payload: P;
}

// --- Payload types ---

export interface AgentRegisterPayload {
  name: string;
  os: string;
  arch: string;
}

export interface AgentHeartbeatPayload {
  name: string;
}

export interface TaskDispatchPayload {
  taskId: string;
  prompt: string;
  sessionId: string | undefined;
  traceId?: string;
  maxBudgetUsd?: number;
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

// --- Concrete message types ---

export type AgentRegister = Message<'agent:register', AgentRegisterPayload>;
export type AgentHeartbeat = Message<'agent:heartbeat', AgentHeartbeatPayload>;
export type TaskDispatch = Message<'task:dispatch', TaskDispatchPayload>;
export type TaskOutput = Message<'task:output', TaskOutputPayload>;
export type TaskComplete = Message<'task:complete', TaskCompletePayload>;
export type TaskError = Message<'task:error', TaskErrorPayload>;
export type CliRequest = Message<'cli:request', CliRequestPayload>;
export type CliResponse = Message<'cli:response', CliResponsePayload>;

export type AnyMessage =
  | AgentRegister
  | AgentHeartbeat
  | TaskDispatch
  | TaskOutput
  | TaskComplete
  | TaskError
  | CliRequest
  | CliResponse;

// --- Factory functions ---

function makeMessage<T extends string, P>(type: T, payload: P): Message<T, P> {
  return {
    id: randomUUID(),
    type,
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
]);

export function parseMessage(raw: string): AnyMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.id !== 'string') return null;
    if (typeof parsed.type !== 'string' || !VALID_TYPES.has(parsed.type)) return null;
    if (typeof parsed.timestamp !== 'number') return null;
    if (typeof parsed.payload !== 'object' || parsed.payload === null) return null;
    return parsed as AnyMessage;
  } catch {
    return null;
  }
}
