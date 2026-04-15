import { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import type { TaskStore, TaskStatus } from './tasks.js';
import type { AgentRegistry } from './registry.js';
import type { TaskQueue } from './queue.js';
import type { TransferManager } from './transfer.js';
import { validateToken } from '../shared/auth.js';
import { metrics } from '../shared/metrics.js';
import { type UserStore, type UserRole } from './user-store.js';
import { type WebhookStore } from './webhook-store.js';
import { resolveTemplate } from './webhook-template.js';
import { RateLimiter } from '../shared/rate-limiter.js';
import { type ScheduleStore, validateCronExpression } from './scheduler.js';

export const DEFAULT_ORG_ID = '__default__';

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

function resolveUser(req: IncomingMessage, token: string, userStore?: UserStore): { userId: string | null; role: UserRole; orgId: string } {
  const provided = getProvidedToken(req);
  if (validateToken(provided, token)) {
    return { userId: null, role: 'admin', orgId: DEFAULT_ORG_ID };
  }
  if (userStore) {
    const resolved = userStore.resolveApiKey(provided);
    if (resolved) {
      const memberships = userStore.getOrgMembership(resolved.userId);
      const orgId = memberships.length > 0 ? memberships[0].orgId : DEFAULT_ORG_ID;
      return { userId: resolved.userId, role: resolved.role as UserRole, orgId };
    }
  }
  return { userId: null, role: 'viewer', orgId: DEFAULT_ORG_ID };
}

export interface AgentMessageRelayResult {
  status: 'delivered' | 'agent-offline' | 'unknown-agent';
}

// Per-webhook rate limiter map: webhook name -> RateLimiter (10 req/min)
const webhookRateLimiters = new Map<string, RateLimiter>();

function getWebhookRateLimiter(name: string): RateLimiter {
  let limiter = webhookRateLimiters.get(name);
  if (!limiter) {
    limiter = new RateLimiter(10, 60_000);
    webhookRateLimiters.set(name, limiter);
  }
  return limiter;
}

function verifyHmac(secret: string, rawBody: string, signatureHeader: string): boolean {
  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function createRestHandler(options: {
  store: TaskStore;
  registry: AgentRegistry;
  token: string;
  queue?: TaskQueue;
  userStore?: UserStore;
  webhookStore?: WebhookStore;
  scheduleStore?: ScheduleStore;
  getOrgRegistry?: (orgId: string) => AgentRegistry;
  getOrgQueue?: (orgId: string) => TaskQueue | undefined;
  relayAgentMessage?: (fromAgent: string, toAgent: string, correlationId: string, topic: string, body: string) => AgentMessageRelayResult;
  transferManager?: TransferManager;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const { store, registry, token, queue, userStore, webhookStore, scheduleStore, getOrgRegistry, getOrgQueue, relayAgentMessage, transferManager } = options;

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';

    // Strip query string for routing
    const questionMark = rawUrl.indexOf('?');
    const pathname = questionMark === -1 ? rawUrl : rawUrl.slice(0, questionMark);
    const search = questionMark === -1 ? '' : rawUrl.slice(questionMark + 1);

    // POST /hooks/:name — webhook trigger (HMAC auth, not Bearer)
    const hooksMatch = pathname.match(/^\/hooks\/([^/]+)$/);
    if (method === 'POST' && hooksMatch) {
      if (!webhookStore) {
        sendJson(res, 501, { error: 'Webhook support not enabled' });
        return;
      }
      const hookName = hooksMatch[1];
      const webhook = webhookStore.getByName(hookName);
      if (!webhook) {
        sendJson(res, 404, { error: `Webhook "${hookName}" not found` });
        return;
      }

      // Rate limit per webhook
      const limiter = getWebhookRateLimiter(hookName);
      if (!limiter.tryConsume()) {
        sendJson(res, 429, { error: 'Rate limit exceeded' });
        return;
      }

      // Read raw body before HMAC verification
      let rawBody: string;
      try {
        rawBody = await readBody(req);
      } catch {
        sendJson(res, 400, { error: 'Request body too large or unreadable' });
        return;
      }

      // HMAC verification if webhook has a secret
      if (webhook.secret) {
        const sigHeader = (req.headers['x-hub-signature-256'] as string | undefined) ?? '';
        if (!sigHeader) {
          sendJson(res, 401, { error: 'Missing X-Hub-Signature-256 header' });
          return;
        }
        if (!verifyHmac(webhook.secret, rawBody, sigHeader)) {
          sendJson(res, 401, { error: 'Invalid HMAC signature' });
          return;
        }
      }

      // Parse payload
      let payload: unknown;
      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      // Render prompt template
      const prompt = resolveTemplate(webhook.promptTemplate, { payload });

      // Dispatch task
      const agentName = webhook.agentName;
      const hookRegistry = getOrgRegistry ? getOrgRegistry(webhook.orgId) : registry;
      const hookQueue = getOrgQueue ? getOrgQueue(webhook.orgId) : queue;

      const agent = hookRegistry.get(agentName);
      if (!agent) {
        sendJson(res, 404, { error: `Agent "${agentName}" not found` });
        return;
      }

      const traceId = randomUUID();
      const task = store.create({ agentName, prompt, traceId, orgId: webhook.orgId });
      webhookStore.recordTrigger(hookName);

      if (hookQueue) {
        hookQueue.enqueue(task.id, agentName);
        sendJson(res, 202, { taskId: task.id, webhook: hookName, status: 'queued' });
      } else {
        sendJson(res, 202, { taskId: task.id, webhook: hookName, status: task.status });
      }
      return;
    }

    // Auth check for all /api/* routes and /metrics
    if (pathname.startsWith('/api/') || pathname === '/metrics') {
      if (!isAuthorized(req, token, userStore)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    // Resolve caller's role and org context
    const callerRole = resolveRole(req, token, userStore);
    const caller = resolveUser(req, token, userStore);
    const callerOrgId = caller.orgId;
    // Use org-scoped registry/queue if available, otherwise fall back to defaults
    const activeRegistry = getOrgRegistry ? getOrgRegistry(callerOrgId) : registry;
    const activeQueue = getOrgQueue ? getOrgQueue(callerOrgId) : queue;

    // GET /api/agents
    if (method === 'GET' && pathname === '/api/agents') {
      const agents = activeRegistry.list();
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
        const tasks = store.list(statusParam as TaskStatus, callerOrgId);
        sendJson(res, 200, { tasks });
        return;
      }

      const tasks = store.list(undefined, callerOrgId);
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
      const pool = typeof payload['pool'] === 'string' && payload['pool'].length > 0 ? payload['pool'] : null;
      let agentName = typeof payload['agentName'] === 'string' ? payload['agentName'] : null;
      const prompt = typeof payload['prompt'] === 'string' ? payload['prompt'] : null;

      // Resolve agent from pool when pool is provided
      if (pool) {
        const picked = activeRegistry.pickFromPool(pool);
        if (!picked) {
          sendJson(res, 503, { error: `No available agents in pool "${pool}"` });
          return;
        }
        agentName = picked.name;
      }

      if (!agentName || !prompt) {
        sendJson(res, 400, { error: 'Missing required fields: agentName or pool, prompt' });
        return;
      }

      const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined;

      const agent = activeRegistry.get(agentName);
      if (!agent) {
        sendJson(res, 404, { error: `Agent "${agentName}" not found` });
        return;
      }

      const traceId = randomUUID();
      const task = store.create({ agentName, prompt, sessionId, traceId, orgId: callerOrgId });

      if (activeQueue) {
        activeQueue.enqueue(task.id, agentName);
        sendJson(res, 202, { taskId: task.id, agentName, status: 'queued' });
      } else {
        sendJson(res, 202, { taskId: task.id, agentName, status: task.status });
      }
      return;
    }

    // ── Org management ───────────────────────────────────────────────────────────

    // POST /api/orgs — admin only, create an org
    if (method === 'POST' && pathname === '/api/orgs') {
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
      const orgName = typeof payload['name'] === 'string' ? payload['name'] : null;
      if (!orgName) {
        sendJson(res, 400, { error: 'Missing required field: name' });
        return;
      }
      try {
        const org = userStore.createOrg(orgName);
        // Add creator as org admin if they are a user (not legacy token)
        if (caller.userId) {
          userStore.addOrgMember(org.id, caller.userId, 'admin');
        }
        sendJson(res, 201, { org });
      } catch {
        sendJson(res, 409, { error: `Org name "${orgName}" already exists` });
      }
      return;
    }

    // GET /api/orgs — list orgs the caller belongs to
    if (method === 'GET' && pathname === '/api/orgs') {
      if (!userStore) { sendJson(res, 501, { error: 'User management not enabled' }); return; }
      if (caller.userId) {
        // Return only orgs the user is a member of
        const memberships = userStore.getOrgMembership(caller.userId);
        const orgs = memberships.map(m => {
          const org = userStore.getOrg(m.orgId);
          return org ? { ...org, memberRole: m.role } : null;
        }).filter(Boolean);
        sendJson(res, 200, { orgs });
      } else {
        // Legacy admin token — return all orgs
        const orgs = userStore.listOrgs();
        sendJson(res, 200, { orgs });
      }
      return;
    }

    // POST /api/orgs/:id/members — add member to org (org admin only)
    const orgMembersMatch = pathname.match(/^\/api\/orgs\/([^/]+)\/members$/);
    if (method === 'POST' && orgMembersMatch) {
      if (!userStore) { sendJson(res, 501, { error: 'User management not enabled' }); return; }
      const orgId = orgMembersMatch[1];
      const org = userStore.getOrg(orgId);
      if (!org) { sendJson(res, 404, { error: `Org "${orgId}" not found` }); return; }
      // Check: caller must be org admin or global admin
      const isglobalAdmin = callerRole === 'admin';
      const isOrgAdmin = caller.userId ? userStore.getUserOrg(caller.userId, orgId)?.role === 'admin' : false;
      if (!isglobalAdmin && !isOrgAdmin) { sendJson(res, 403, { error: 'Forbidden' }); return; }
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
      const userId = typeof payload['userId'] === 'string' ? payload['userId'] : null;
      const memberRole = typeof payload['role'] === 'string' ? payload['role'] : 'operator';
      const VALID_ROLES = new Set(['admin', 'operator', 'viewer']);
      if (!VALID_ROLES.has(memberRole)) {
        sendJson(res, 400, { error: `Invalid role: ${memberRole}. Valid: admin, operator, viewer` });
        return;
      }
      if (!userId) {
        sendJson(res, 400, { error: 'Missing required field: userId' });
        return;
      }
      const targetUser = userStore.getUser(userId);
      if (!targetUser) { sendJson(res, 404, { error: `User "${userId}" not found` }); return; }
      userStore.addOrgMember(orgId, userId, memberRole);
      sendJson(res, 200, { orgId, userId, role: memberRole });
      return;
    }

    // DELETE /api/orgs/:id/members/:userId — remove member from org (org admin only)
    const orgMemberDeleteMatch = pathname.match(/^\/api\/orgs\/([^/]+)\/members\/([^/]+)$/);
    if (method === 'DELETE' && orgMemberDeleteMatch) {
      if (!userStore) { sendJson(res, 501, { error: 'User management not enabled' }); return; }
      const orgId = orgMemberDeleteMatch[1];
      const targetUserId = orgMemberDeleteMatch[2];
      const org = userStore.getOrg(orgId);
      if (!org) { sendJson(res, 404, { error: `Org "${orgId}" not found` }); return; }
      const isglobalAdmin = callerRole === 'admin';
      const isOrgAdmin = caller.userId ? userStore.getUserOrg(caller.userId, orgId)?.role === 'admin' : false;
      if (!isglobalAdmin && !isOrgAdmin) { sendJson(res, 403, { error: 'Forbidden' }); return; }
      userStore.removeOrgMember(orgId, targetUserId);
      sendJson(res, 200, { removed: true });
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

    // GET /api/transfers — list active file transfers
    if (method === 'GET' && pathname === '/api/transfers') {
      if (!transferManager) {
        sendJson(res, 501, { error: 'Transfer manager not available' });
        return;
      }
      const transfers = transferManager.getActiveTransfers();
      sendJson(res, 200, { transfers });
      return;
    }

    // POST /api/push — initiate a push transfer
    if (method === 'POST' && pathname === '/api/push') {
      if (!transferManager) {
        sendJson(res, 501, { error: 'Transfer manager not available' });
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
      const agentName = typeof payload['agentName'] === 'string' ? payload['agentName'] : null;
      const destPath = typeof payload['destPath'] === 'string' ? payload['destPath'] : null;
      const filename = typeof payload['filename'] === 'string' ? payload['filename'] : null;
      if (!agentName || !destPath || !filename) {
        sendJson(res, 400, { error: 'Missing required fields: agentName, destPath, filename' });
        return;
      }
      const agent = activeRegistry.get(agentName);
      if (!agent) {
        sendJson(res, 404, { error: `Agent "${agentName}" not found` });
        return;
      }
      const transferId = randomUUID();
      // Return transferId — client will stream chunks over WebSocket
      sendJson(res, 202, { transferId });
      return;
    }

    // POST /api/pull — initiate a pull transfer
    if (method === 'POST' && pathname === '/api/pull') {
      if (!transferManager) {
        sendJson(res, 501, { error: 'Transfer manager not available' });
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
      const agentName = typeof payload['agentName'] === 'string' ? payload['agentName'] : null;
      const sourcePath = typeof payload['sourcePath'] === 'string' ? payload['sourcePath'] : null;
      if (!agentName || !sourcePath) {
        sendJson(res, 400, { error: 'Missing required fields: agentName, sourcePath' });
        return;
      }
      const agent = activeRegistry.get(agentName);
      if (!agent) {
        sendJson(res, 404, { error: `Agent "${agentName}" not found` });
        return;
      }
      const transferId = randomUUID();
      sendJson(res, 202, { transferId });
      return;
    }

    // ── Schedule management ──────────────────────────────────────────────────────

    // GET /api/schedules — list schedules
    if (method === 'GET' && pathname === '/api/schedules') {
      if (!scheduleStore) { sendJson(res, 501, { error: 'Scheduler not enabled' }); return; }
      const schedules = scheduleStore.list(callerOrgId === DEFAULT_ORG_ID ? undefined : callerOrgId);
      sendJson(res, 200, { schedules });
      return;
    }

    // POST /api/schedules — create a schedule
    if (method === 'POST' && pathname === '/api/schedules') {
      if (!scheduleStore) { sendJson(res, 501, { error: 'Scheduler not enabled' }); return; }
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
      const cronExpr = typeof payload['cronExpr'] === 'string' ? payload['cronExpr'] : null;
      const agentName = typeof payload['agentName'] === 'string' ? payload['agentName'] : null;
      const prompt = typeof payload['prompt'] === 'string' ? payload['prompt'] : null;
      if (!cronExpr || !agentName || !prompt) {
        sendJson(res, 400, { error: 'Missing required fields: cronExpr, agentName, prompt' });
        return;
      }
      const cronError = validateCronExpression(cronExpr);
      if (cronError) {
        sendJson(res, 400, { error: `Invalid cron expression: ${cronError}` });
        return;
      }
      const budgetUsd = typeof payload['budgetUsd'] === 'number' ? payload['budgetUsd'] : undefined;
      const allowedTools = Array.isArray(payload['allowedTools'])
        ? (payload['allowedTools'] as unknown[]).filter((t): t is string => typeof t === 'string')
        : undefined;
      try {
        const schedule = scheduleStore.create({
          cronExpr,
          agentName,
          prompt,
          budgetUsd,
          allowedTools,
          orgId: callerOrgId,
        });
        sendJson(res, 201, { schedule });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Failed to create schedule' });
      }
      return;
    }

    // GET /api/schedules/:id — get single schedule
    const scheduleMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
    if (method === 'GET' && scheduleMatch) {
      if (!scheduleStore) { sendJson(res, 501, { error: 'Scheduler not enabled' }); return; }
      const id = scheduleMatch[1];
      const schedule = scheduleStore.get(id);
      if (!schedule) { sendJson(res, 404, { error: `Schedule "${id}" not found` }); return; }
      sendJson(res, 200, { schedule });
      return;
    }

    // DELETE /api/schedules/:id — delete a schedule
    if (method === 'DELETE' && scheduleMatch) {
      if (!scheduleStore) { sendJson(res, 501, { error: 'Scheduler not enabled' }); return; }
      const id = scheduleMatch[1];
      const schedule = scheduleStore.get(id);
      if (!schedule) { sendJson(res, 404, { error: `Schedule "${id}" not found` }); return; }
      scheduleStore.delete(id);
      sendJson(res, 200, { deleted: true });
      return;
    }

    // PATCH /api/schedules/:id — pause or resume
    if (method === 'PATCH' && scheduleMatch) {
      if (!scheduleStore) { sendJson(res, 501, { error: 'Scheduler not enabled' }); return; }
      const id = scheduleMatch[1];
      const schedule = scheduleStore.get(id);
      if (!schedule) { sendJson(res, 404, { error: `Schedule "${id}" not found` }); return; }
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
      if (typeof payload['paused'] !== 'boolean') {
        sendJson(res, 400, { error: 'Missing required field: paused (boolean)' });
        return;
      }
      scheduleStore.setPaused(id, payload['paused']);
      const updated = scheduleStore.get(id);
      sendJson(res, 200, { schedule: updated });
      return;
    }

    // GET /api/webhooks — list webhooks
    if (method === 'GET' && pathname === '/api/webhooks') {
      if (!webhookStore) { sendJson(res, 501, { error: 'Webhook support not enabled' }); return; }
      const webhooks = webhookStore.list();
      sendJson(res, 200, { webhooks });
      return;
    }

    // POST /api/webhooks — create webhook
    if (method === 'POST' && pathname === '/api/webhooks') {
      if (!webhookStore) { sendJson(res, 501, { error: 'Webhook support not enabled' }); return; }
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
      const name = typeof payload['name'] === 'string' ? payload['name'] : null;
      const agentName = typeof payload['agentName'] === 'string' ? payload['agentName'] : null;
      const promptTemplate = typeof payload['promptTemplate'] === 'string' ? payload['promptTemplate'] : null;
      if (!name || !agentName || !promptTemplate) {
        sendJson(res, 400, { error: 'Missing required fields: name, agentName, promptTemplate' });
        return;
      }
      const secret = typeof payload['secret'] === 'string' ? payload['secret'] : undefined;
      try {
        const webhook = webhookStore.create({ name, agentName, promptTemplate, secret, orgId: callerOrgId });
        sendJson(res, 201, { webhook });
      } catch (err) {
        sendJson(res, 409, { error: err instanceof Error ? err.message : 'Failed to create webhook' });
      }
      return;
    }

    // GET /api/webhooks/:name — get single webhook
    const webhookMatch = pathname.match(/^\/api\/webhooks\/([^/]+)$/);
    if (method === 'GET' && webhookMatch) {
      if (!webhookStore) { sendJson(res, 501, { error: 'Webhook support not enabled' }); return; }
      const name = webhookMatch[1];
      const webhook = webhookStore.getByName(name);
      if (!webhook) { sendJson(res, 404, { error: `Webhook "${name}" not found` }); return; }
      sendJson(res, 200, { webhook });
      return;
    }

    // POST /api/webhooks/:name/test — dry-run, returns rendered prompt without dispatching
    const webhookTestMatch = pathname.match(/^\/api\/webhooks\/([^/]+)\/test$/);
    if (method === 'POST' && webhookTestMatch) {
      if (!webhookStore) { sendJson(res, 501, { error: 'Webhook support not enabled' }); return; }
      const wtName = decodeURIComponent(webhookTestMatch[1]);
      const wt = webhookStore.getByName(wtName);
      if (!wt) { sendJson(res, 404, { error: `Webhook "${wtName}" not found` }); return; }
      let wtBody: unknown;
      try {
        const raw = await readBody(req);
        wtBody = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      const renderedPrompt = resolveTemplate(wt.promptTemplate, { payload: wtBody });
      sendJson(res, 200, { webhook: wtName, renderedPrompt });
      return;
    }

    // DELETE /api/webhooks/:name — delete webhook
    if (method === 'DELETE' && webhookMatch) {
      if (!webhookStore) { sendJson(res, 501, { error: 'Webhook support not enabled' }); return; }
      const name = webhookMatch[1];
      const webhook = webhookStore.getByName(name);
      if (!webhook) { sendJson(res, 404, { error: `Webhook "${name}" not found` }); return; }
      webhookStore.delete(name);
      sendJson(res, 200, { deleted: true });
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
