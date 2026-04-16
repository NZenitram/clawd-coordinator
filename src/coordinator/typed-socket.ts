import WebSocket from 'ws';
import type { RateLimiter } from '../shared/rate-limiter.js';

export interface SocketMeta {
  user?: { userId: string | null; role: string; orgId: string };
  rateLimiter?: RateLimiter;
  isAlive: boolean;
  orgId?: string;
}

const meta = new WeakMap<WebSocket, SocketMeta>();

export function getMeta(ws: WebSocket): SocketMeta {
  let m = meta.get(ws);
  if (!m) { m = { isAlive: true }; meta.set(ws, m); }
  return m;
}

export function setMeta(ws: WebSocket, updates: Partial<SocketMeta>): void {
  Object.assign(getMeta(ws), updates);
}
