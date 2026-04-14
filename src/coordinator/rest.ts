import { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { TaskStore, TaskStatus } from './tasks.js';
import type { AgentRegistry } from './registry.js';
import type { TaskQueue } from './queue.js';
import { validateToken } from '../shared/auth.js';

const VALID_STATUSES = new Set<TaskStatus>(['pending', 'running', 'completed', 'error']);

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Connection': 'close',
  });
  res.end(json);
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

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization'] ?? '';
  const provided = header.replace(/^Bearer\s+/i, '');
  if (!provided) return false;
  return validateToken(provided, token);
}

export function createRestHandler(options: {
  store: TaskStore;
  registry: AgentRegistry;
  token: string;
  queue?: TaskQueue;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const { store, registry, token, queue } = options;

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';

    // Strip query string for routing
    const questionMark = rawUrl.indexOf('?');
    const pathname = questionMark === -1 ? rawUrl : rawUrl.slice(0, questionMark);
    const search = questionMark === -1 ? '' : rawUrl.slice(questionMark + 1);

    // Auth check for all /api/* routes
    if (pathname.startsWith('/api/')) {
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

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

    // 404 for all other /api/* routes
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // Non-API routes — 404 (WebSocket upgrade requests are handled by ws, not here)
    sendJson(res, 404, { error: 'Not found' });
  };
}
