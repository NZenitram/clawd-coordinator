import WebSocket from 'ws';
import { AgentRegistry } from './registry.js';
import type { TaskQueue } from './queue.js';

export interface OrgState {
  agentSockets: Map<string, WebSocket>;
  cliSockets: Set<WebSocket>;
  taskSubscribers: Map<string, Set<WebSocket>>;
  taskOwners: Map<string, WebSocket>;
  registry: AgentRegistry;
  queue: TaskQueue;
  sessionListPending: Map<string, { cliSocket: WebSocket; cliRequestId: string; timer: ReturnType<typeof setTimeout> }>;
  selfUpdatePending: Map<string, { cliSocket: WebSocket; cliRequestId: string; timer: ReturnType<typeof setTimeout> }>;
}
