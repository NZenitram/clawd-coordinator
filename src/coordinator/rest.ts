import { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { TaskStore, TaskStatus } from './tasks.js';
import type { AgentRegistry } from './registry.js';
import type { TaskQueue } from './queue.js';
import { validateToken } from '../shared/auth.js';
import { metrics } from '../shared/metrics.js';
import { type UserStore, type UserRole } from './user-store.js';

const VALID_STATUSES = new Set<TaskStatus>(['pending', 'running', 'completed', 'error', 'dead-letter']);

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Connection': 'close',
  });
  res.end(json);
}

function sendText(res: ServerResponse, statusCode: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Connection': 'close',
  });
  res.end(body);
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const VALID_ROLES = new Set<UserRole>(['admin', 'operator', 'viewer']);

function getProvidedToken(req: IncomingMessage): string {
  const header = req.headers['authorization'] ?? '';
  return header.replace(/^Bearer\s+/i, '');
}

function isAuthorized(req: IncomingMessage, token: string, userStore?: UserStore): boolean {
  const provided = getProvidedToken(req);
  if (!provided) return false;
  if (validateToken(provided, token)) return true;
  if (userStore) {
    const resolved = userStore.resolveApiKey(provided);
    if (resolved) return true;
  }
  return false;
}

function resolveRole(req: IncomingMessage, token: string, userStore?: UserStore): UserRole {
  const provided = getProvidedToken(req);
  if (validateToken(provided, token)) return 'admin';
  if (userStore) {
    const resolved = userStore.resolveApiKey(provided);
    if (resolved) return resolved.role as UserRole;
  }
  return 'viewer';
}

export interface AgentMessageRelayResult {
  status: 'delivered' | 'agent-offline' | 'unknown-agent';
}

export function createRestHandler(options: {
  store: TaskStore;
  registry: AgentRegistry;
  token: string;
  queue?: TaskQueue;
  userStore?: UserStore;
  relayAgentMessage?: (fromAgent: string, toAgent: string, correlationId: string, topic: string, body: string) => AgentMessageRelayResult;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const { store, registry, token, queue, userStore, relayAgentMessage } = options;

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';

    // Strip query string for routing
    const questionMark = rawUrl.indexOf('?');
    const pathname = questionMark === -1 ? rawUrl : rawUrl.slice(0, questionMark);
    const search = questionMark === -1 ? '' : rawUrl.slice(questionMark + 1);

    // Auth check for all /api/* routes and /metrics
    if (pathname.startsWith('/api/') || pathname === '/metrics') {
      if (!isAuthorized(req, token, userStore)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    // Resolve caller's role (used for admin-only endpoints)
    const callerRole = resolveRole(req, token, userStore);

    // GET /api/agents
    if (method === 'GET' && pathname === '/api/agents') {
      const agents = registry.list();
      sendJson(res, 200, { agents });
      return;
    }

    // GET /api/tasks
    if (method === 'GET' && pathname === '/api/tasks') {
      const params = new URLSearchParams(search);
      const statusParam = params.get('status');

      if (statusParam !== null) {
        if (!VALID_STATUSES.has(statusParam as TaskStatus)) {
          sendJson(res, 400, {
            error: `Invalid status filter: ${statusParam}. Valid values: ${[...VALID_STATUSES].join(', ')}`,
          });
          return;
        }
        const tasks = store.list(statusParam as TaskStatus);
        sendJson(res, 200, { tasks });
        return;
      }

      const tasks = store.list();
      sendJson(res, 200, { tasks });
      return;
    }

    // GET /api/tasks/:id
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'GET' && taskMatch) {
      const taskId = taskMatch[1];
      const task = store.get(taskId);
      sendJson(res, 200, { task });
      return;
    }

    // POST /api/dispatch
    if (method === 'POST' && pathname === '/api/dispatch') {
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      if (typeof body !== 'object' || body === null) {
        sendJson(res, 400, { error: 'Request body must be a JSON object' });
        return;
      }

      const payload = body as Record<string, unknown>;
      const agentName = typeof payload['agentName'] === 'string' ? payload['agentName'] : null;
      const prompt = typeof payload['prompt'] === 'string' ? payload['prompt'] : null;

      if (!agentName || !prompt) {
        sendJson(res, 400, { error: 'Missing required fields: agentName, prompt' });
        return;
      }

      const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined;

      const agent = registry.get(agentName);
      if (!agent) {
        sendJson(res, 404, { error: `Agent "${agentName}" not found` });
        return;
      }

      const traceId = randomUUID();
      const task = store.create({ agentName, prompt, sessionId, traceId });

      if (queue) {
        queue.enqueue(task.id, agentName);
        sendJson(res, 202, { taskId: task.id, status: 'queued' });
      } else {
        sendJson(res, 202, { taskId: task.id, status: task.status });
      }
      return;
    }

    // ── User management (admin only) ────────────────────────────────────────────

    // GET /api/users
    if (method === 'GET' && pathname === '/api/users') {
      if (!userStore) { sendJson(res, 501, { error: 'User management not enabled' }); return; }
      if (callerRole !== 'admin') { sendJson(res, 403, { error: 'Forbidden' }); return; }
      const users = userStore.listUsers();
      sendJson(res, 200, { users });
      return;
    }

    // POST /api/users
    if (method === 'POST' && pathname === '/api/users') {
      if (!userStore) { sendJson(res, 501, { error: 'User management not enabled' }); return; }
      if (callerRole !== 'admin') { sendJson(res, 403, { error: 'Forbidden' }); return; }
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      if (typeof body !== 'object' || body === null) {
        sendJson(res, 400, { error: 'Request body must be a JSON object' });
        return;
      }
      const payload = body as Record<string, unknown>;
      const username = typeof payload['username'] === 'string' ? payload['username'] : null;
      const role = typeof payload['role'] === 'string' ? payload['role'] : 'operator';
      if (!username) {
        sendJson(res, 400, { error: 'Missing required field: username' });
        return;
      }
      if (!VALID_ROLES.has(role as UserRole)) {
        sendJson(res, 400, { error: `Invalid role: ${role}. Valid: admin, operator, viewer` });
        return;
      }
      try {
        const user = userStore.createUser(username, role as UserRole);
        sendJson(res, 201, { user });
      } catch {
        sendJson(res, 409, { error: `Username "${username}" already exists` });
      }
      return;
    }

    // POST /api/users/:id/keys
    const userKeysMatch = pathname.match(/^\/api\/users\/([^/]+)\/keys$/);
    if (method === 'POST' && userKeysMatch) {
      if (!userStore) { sendJson(res, 501, { error: 'User management not enabled' }); return; }
      if (callerRole !== 'admin') { sendJson(res, 403, { error: 'Forbidden' }); return; }
      const userId = userKeysMatch[1];
      const user = userStore.getUser(userId);
      if (!user) {
        sendJson(res, 404, { error: `User "${userId}" not found` });
        return;
      }
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      const label = (typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>)['label'] === 'string')
        ? (body as Record<string, unknown>)['label'] as string
        : undefined;
      const { key, keyId } = userStore.createApiKey(userId, label);
      sendJson(res, 201, { keyId, key });
      return;
    }

    // DELETE /api/keys/:id
    const keyDeleteMatch = pathname.match(/^\/api\/keys\/([^/]+)$/);
    if (method === 'DELETE' && keyDeleteMatch) {
      if (!userStore) { sendJson(res, 501, { error: 'User management not enabled' }); return; }
      if (callerRole !== 'admin') { sendJson(res, 403, { error: 'Forbidden' }); return; }
      const keyId = keyDeleteMatch[1];
      userStore.revokeApiKey(keyId);
      sendJson(res, 200, { revoked: true });
      return;
    }

    // GET /metrics — Prometheus text format
    if (method === 'GET' && pathname === '/metrics') {
      const body = await metrics.registry.metrics();
      sendText(res, 200, body, 'text/plain; version=0.0.4; charset=utf-8');
      return;
    }

    // GET /api/stats — JSON summary of key metrics
    if (method === 'GET' && pathname === '/api/stats') {
      sendJson(res, 200, { stats: metrics.getStats() });
      return;
    }

    // POST /api/message — relay agent-to-agent message
    if (method === 'POST' && pathname === '/api/message') {
      if (!relayAgentMessage) {
        sendJson(res, 501, { error: 'Agent messaging not available' });
        return;
      }
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      if (typeof body !== 'object' || body === null) {
        sendJson(res, 400, { error: 'Request body must be a JSON object' });
        return;
      }
      const payload = body as Record<string, unknown>;
      const fromAgent = typeof payload['fromAgent'] === 'string' ? payload['fromAgent'] : null;
      const toAgent = typeof payload['toAgent'] === 'string' ? payload['toAgent'] : null;
      const topic = typeof payload['topic'] === 'string' ? payload['topic'] : null;
      const msgBody = typeof payload['body'] === 'string' ? payload['body'] : null;
      if (!fromAgent || !toAgent || !topic || msgBody === null) {
        sendJson(res, 400, { error: 'Missing required fields: fromAgent, toAgent, topic, body' });
        return;
      }
      const correlationId = randomUUID();
      const result = relayAgentMessage(fromAgent, toAgent, correlationId, topic, msgBody);
      sendJson(res, 200, { correlationId, status: result.status });
      return;
    }

    // 404 for all other /api/* routes
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // Non-API routes — 404 (WebSocket upgrade requests are handled by ws, not here)
    sendJson(res, 404, { error: 'Not found' });
  };
}
