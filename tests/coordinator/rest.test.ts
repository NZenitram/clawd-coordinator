import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { Coordinator } from '../../src/coordinator/server.js';
import { UserStore } from '../../src/coordinator/user-store.js';
import { serializeMessage, createAgentRegister } from '../../src/protocol/messages.js';

function connectAgent(name: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/agent`, {
      headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
    });
    ws.on('open', () => {
      ws.send(serializeMessage(createAgentRegister({ name, os: 'linux', arch: 'x64' })));
      setTimeout(() => resolve(ws), 50);
    });
    ws.on('error', reject);
  });
}

const TEST_TOKEN = 'rest-test-token-xyz';
const TEST_PORT = 9880;
const BASE_URL = `http://localhost:${TEST_PORT}`;

interface HttpResponse {
  statusCode: number;
  body: unknown;
}

function request(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const bodyStr = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.token !== undefined) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }
    if (bodyStr !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }

    const req = http.request(`${BASE_URL}${path}`, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = null;
        }
        resolve({ statusCode: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }
    req.end();
  });
}

describe('REST API', () => {
  let coordinator: Coordinator;

  beforeEach(async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();
  });

  afterEach(async () => {
    await coordinator.stop();
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request('GET', '/api/agents');
    expect(res.statusCode).toBe(401);
    expect((res.body as any).error).toBe('Unauthorized');
  });

  it('returns 401 when token is wrong', async () => {
    const res = await request('GET', '/api/agents', { token: 'bad-token' });
    expect(res.statusCode).toBe(401);
    expect((res.body as any).error).toBe('Unauthorized');
  });

  // ── GET /api/agents ─────────────────────────────────────────────────────────

  it('GET /api/agents returns empty list when no agents connected', async () => {
    const res = await request('GET', '/api/agents', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
    expect((res.body as any).agents).toEqual([]);
  });

  // ── GET /api/tasks ──────────────────────────────────────────────────────────

  it('GET /api/tasks returns empty list initially', async () => {
    const res = await request('GET', '/api/tasks', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
    expect((res.body as any).tasks).toEqual([]);
  });

  it('GET /api/tasks?status=pending returns filtered tasks', async () => {
    const agentWs = await connectAgent('filter-agent');
    await request('POST', '/api/dispatch', {
      token: TEST_TOKEN,
      body: { agentName: 'filter-agent', prompt: 'hello' },
    });

    const res = await request('GET', '/api/tasks?status=pending', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
    const tasks = (res.body as any).tasks as unknown[];
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    for (const t of tasks) {
      expect((t as any).status).toBe('pending');
    }
    agentWs.close();
  });

  it('GET /api/tasks?status=invalid returns 400', async () => {
    const res = await request('GET', '/api/tasks?status=bogus', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toContain('Invalid status filter');
  });

  it('GET /api/tasks?status=dead-letter returns 200 with empty list initially', async () => {
    const res = await request('GET', '/api/tasks?status=dead-letter', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
    expect((res.body as any).tasks).toEqual([]);
  });

  // ── GET /api/tasks/:id ──────────────────────────────────────────────────────

  it('GET /api/tasks/:id returns task by ID', async () => {
    const agentWs = await connectAgent('my-agent');
    const dispatchRes = await request('POST', '/api/dispatch', {
      token: TEST_TOKEN,
      body: { agentName: 'my-agent', prompt: 'do stuff' },
    });
    const taskId = (dispatchRes.body as any).taskId as string;

    const res = await request('GET', `/api/tasks/${taskId}`, { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
    const task = (res.body as any).task;
    expect(task).not.toBeNull();
    expect(task.id).toBe(taskId);
    expect(task.agentName).toBe('my-agent');
    expect(task.prompt).toBe('do stuff');
    expect(task.status).toBe('pending');
    agentWs.close();
  });

  it('GET /api/tasks/:id returns null task for unknown ID', async () => {
    const res = await request('GET', '/api/tasks/nonexistent-id', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
    expect((res.body as any).task).toBeNull();
  });

  // ── POST /api/dispatch ──────────────────────────────────────────────────────

  it('POST /api/dispatch creates task and returns taskId', async () => {
    const agentWs = await connectAgent('ci-agent');
    const res = await request('POST', '/api/dispatch', {
      token: TEST_TOKEN,
      body: { agentName: 'ci-agent', prompt: 'run tests' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.body as any;
    expect(typeof body.taskId).toBe('string');
    agentWs.close();
  });

  it('POST /api/dispatch accepts optional sessionId', async () => {
    const agentWs = await connectAgent('ci-agent-2');
    const res = await request('POST', '/api/dispatch', {
      token: TEST_TOKEN,
      body: { agentName: 'ci-agent-2', prompt: 'resume work', sessionId: 'sess-123' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.body as any;
    expect(typeof body.taskId).toBe('string');

    const taskRes = await request('GET', `/api/tasks/${body.taskId}`, { token: TEST_TOKEN });
    expect((taskRes.body as any).task.sessionId).toBe('sess-123');
    agentWs.close();
  });

  it('POST /api/dispatch returns 404 for unknown agent', async () => {
    const res = await request('POST', '/api/dispatch', {
      token: TEST_TOKEN,
      body: { agentName: 'ghost-agent', prompt: 'hello' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.body as any).error).toContain('not found');
  });

  it('POST /api/dispatch returns 400 when agentName is missing', async () => {
    const res = await request('POST', '/api/dispatch', {
      token: TEST_TOKEN,
      body: { prompt: 'run tests' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toContain('agentName');
  });

  it('POST /api/dispatch returns 400 when prompt is missing', async () => {
    const res = await request('POST', '/api/dispatch', {
      token: TEST_TOKEN,
      body: { agentName: 'ci-agent' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toContain('prompt');
  });

  it('POST /api/dispatch returns 400 for invalid JSON body', async () => {
    const res = await new Promise<HttpResponse>((resolve, reject) => {
      const body = 'not-json';
      const req = http.request(`${BASE_URL}/api/dispatch`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TEST_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
      }, (httpRes) => {
        const chunks: Buffer[] = [];
        httpRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        httpRes.on('end', () => {
          resolve({
            statusCode: httpRes.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toContain('Invalid JSON');
  });

  // ── POST /api/message ───────────────────────────────────────────────────────

  it('POST /api/message returns unknown-agent when target not connected', async () => {
    const res = await request('POST', '/api/message', {
      token: TEST_TOKEN,
      body: {
        fromAgent: 'rest-sender',
        toAgent: 'nonexistent-agent',
        topic: 'test',
        body: 'hello',
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as any).status).toBe('unknown-agent');
    expect(typeof (res.body as any).correlationId).toBe('string');
  });

  it('POST /api/message returns 400 when required fields are missing', async () => {
    const res = await request('POST', '/api/message', {
      token: TEST_TOKEN,
      body: { fromAgent: 'a', toAgent: 'b' }, // missing topic and body
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toContain('Missing required fields');
  });

  // ── Unknown routes ──────────────────────────────────────────────────────────

  it('returns 404 for unknown /api/* routes with valid auth', async () => {
    const res = await request('GET', '/api/unknown-endpoint', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(404);
    expect((res.body as any).error).toBe('Not found');
  });

  it('returns 404 for non-API routes', async () => {
    const res = await request('GET', '/health', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(404);
  });

  // ── GET /api/stats ──────────────────────────────────────────────────────────

  it('GET /api/stats returns stats JSON', async () => {
    const res = await request('GET', '/api/stats', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
    expect((res.body as any).stats).toBeDefined();
  });

  // ── GET /metrics ────────────────────────────────────────────────────────────

  it('GET /metrics returns Prometheus text', async () => {
    const res = await request('GET', '/metrics', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
  });
});

// ── User/Org management (requires UserStore) ─────────────────────────────────

const USER_TEST_PORT = 9881;
const USER_BASE_URL = `http://localhost:${USER_TEST_PORT}`;

function userRequest(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.token !== undefined) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }
    if (bodyStr !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const req = http.request(`${USER_BASE_URL}${path}`, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { body = null; }
        resolve({ statusCode: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

describe('REST API — user/org management', () => {
  let coordinator: Coordinator;
  let userStore: UserStore;

  beforeEach(async () => {
    userStore = await UserStore.create(); // in-memory
    coordinator = new Coordinator({ port: USER_TEST_PORT, token: TEST_TOKEN, userStore });
    await coordinator.start();
  });

  afterEach(async () => {
    await coordinator.stop();
    userStore.close();
  });

  // ── GET /api/users ──────────────────────────────────────────────────────────

  it('GET /api/users returns empty user list initially', async () => {
    const res = await userRequest('GET', '/api/users', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
    expect((res.body as any).users).toEqual([]);
  });

  it('GET /api/users returns 501 when userStore not provided (no-store coordinator)', async () => {
    // Spin up a temporary coordinator without a userStore on a distinct port
    const NO_STORE_PORT = 9882;
    const noStoreCoordinator = new Coordinator({ port: NO_STORE_PORT, token: TEST_TOKEN });
    await noStoreCoordinator.start();
    try {
      const res = await new Promise<{ statusCode: number; body: unknown }>((resolve, reject) => {
        const req = http.request(
          `http://localhost:${NO_STORE_PORT}/api/users`,
          { method: 'GET', headers: { 'Authorization': `Bearer ${TEST_TOKEN}` } },
          (httpRes) => {
            const chunks: Buffer[] = [];
            httpRes.on('data', (chunk: Buffer) => chunks.push(chunk));
            httpRes.on('end', () => {
              let body: unknown;
              try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
              catch { body = null; }
              resolve({ statusCode: httpRes.statusCode ?? 0, body });
            });
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(res.statusCode).toBe(501);
    } finally {
      await noStoreCoordinator.stop();
    }
  });

  // ── POST /api/users ─────────────────────────────────────────────────────────

  it('POST /api/users creates a user and returns user object', async () => {
    const res = await userRequest('POST', '/api/users', {
      token: TEST_TOKEN,
      body: { username: 'alice', role: 'operator' },
    });
    expect(res.statusCode).toBe(201);
    const user = (res.body as any).user;
    expect(typeof user.id).toBe('string');
    expect(user.username).toBe('alice');
    expect(user.role).toBe('operator');
  });

  it('POST /api/users returns 409 when username already exists', async () => {
    await userRequest('POST', '/api/users', {
      token: TEST_TOKEN,
      body: { username: 'bob', role: 'viewer' },
    });
    const res = await userRequest('POST', '/api/users', {
      token: TEST_TOKEN,
      body: { username: 'bob', role: 'viewer' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /api/users returns 400 when username is missing', async () => {
    const res = await userRequest('POST', '/api/users', {
      token: TEST_TOKEN,
      body: { role: 'operator' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toContain('username');
  });

  it('POST /api/users returns 400 for invalid role', async () => {
    const res = await userRequest('POST', '/api/users', {
      token: TEST_TOKEN,
      body: { username: 'carol', role: 'superuser' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toContain('Invalid role');
  });

  // ── POST /api/users/:id/keys ────────────────────────────────────────────────

  it('POST /api/users/:id/keys creates an API key', async () => {
    const createRes = await userRequest('POST', '/api/users', {
      token: TEST_TOKEN,
      body: { username: 'dave', role: 'operator' },
    });
    const userId = (createRes.body as any).user.id as string;

    const keyRes = await userRequest('POST', `/api/users/${userId}/keys`, {
      token: TEST_TOKEN,
      body: { label: 'dev-key' },
    });
    expect(keyRes.statusCode).toBe(201);
    const keyBody = keyRes.body as any;
    expect(typeof keyBody.keyId).toBe('string');
    expect(typeof keyBody.key).toBe('string');
    expect(keyBody.key.length).toBeGreaterThan(0);
  });

  it('POST /api/users/:id/keys returns 404 for unknown user', async () => {
    const res = await userRequest('POST', '/api/users/nonexistent-id/keys', {
      token: TEST_TOKEN,
      body: {},
    });
    expect(res.statusCode).toBe(404);
  });

  // ── DELETE /api/keys/:id ────────────────────────────────────────────────────

  it('DELETE /api/keys/:id revokes a key', async () => {
    const createRes = await userRequest('POST', '/api/users', {
      token: TEST_TOKEN,
      body: { username: 'eve', role: 'operator' },
    });
    const userId = (createRes.body as any).user.id as string;

    const keyRes = await userRequest('POST', `/api/users/${userId}/keys`, {
      token: TEST_TOKEN,
      body: {},
    });
    const keyId = (keyRes.body as any).keyId as string;

    const revokeRes = await userRequest('DELETE', `/api/keys/${keyId}`, { token: TEST_TOKEN });
    expect(revokeRes.statusCode).toBe(200);
    expect((revokeRes.body as any).revoked).toBe(true);
  });

  // ── GET /api/orgs ───────────────────────────────────────────────────────────

  it('GET /api/orgs returns empty org list initially', async () => {
    const res = await userRequest('GET', '/api/orgs', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
    expect((res.body as any).orgs).toEqual([]);
  });

  // ── POST /api/orgs ──────────────────────────────────────────────────────────

  it('POST /api/orgs creates an org and returns org object', async () => {
    const res = await userRequest('POST', '/api/orgs', {
      token: TEST_TOKEN,
      body: { name: 'acme' },
    });
    expect(res.statusCode).toBe(201);
    const org = (res.body as any).org;
    expect(typeof org.id).toBe('string');
    expect(org.name).toBe('acme');
  });

  it('POST /api/orgs returns 409 when org name already exists', async () => {
    await userRequest('POST', '/api/orgs', { token: TEST_TOKEN, body: { name: 'dupe-org' } });
    const res = await userRequest('POST', '/api/orgs', { token: TEST_TOKEN, body: { name: 'dupe-org' } });
    expect(res.statusCode).toBe(409);
  });

  it('POST /api/orgs returns 400 when name is missing', async () => {
    const res = await userRequest('POST', '/api/orgs', { token: TEST_TOKEN, body: {} });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toContain('name');
  });

  // ── POST /api/orgs/:id/members ──────────────────────────────────────────────

  it('POST /api/orgs/:id/members adds a user to the org', async () => {
    const orgRes = await userRequest('POST', '/api/orgs', {
      token: TEST_TOKEN,
      body: { name: 'test-org' },
    });
    const orgId = (orgRes.body as any).org.id as string;

    const userRes = await userRequest('POST', '/api/users', {
      token: TEST_TOKEN,
      body: { username: 'frank', role: 'operator' },
    });
    const userId = (userRes.body as any).user.id as string;

    const addRes = await userRequest('POST', `/api/orgs/${orgId}/members`, {
      token: TEST_TOKEN,
      body: { userId, role: 'operator' },
    });
    expect(addRes.statusCode).toBe(200);
    expect((addRes.body as any).orgId).toBe(orgId);
    expect((addRes.body as any).userId).toBe(userId);
  });

  it('POST /api/orgs/:id/members returns 404 for unknown org', async () => {
    const res = await userRequest('POST', '/api/orgs/no-such-org/members', {
      token: TEST_TOKEN,
      body: { userId: 'some-user', role: 'operator' },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── DELETE /api/orgs/:id/members/:userId ─────────────────────────────────────

  it('DELETE /api/orgs/:id/members/:userId removes a member', async () => {
    const orgRes = await userRequest('POST', '/api/orgs', {
      token: TEST_TOKEN,
      body: { name: 'remove-test-org' },
    });
    const orgId = (orgRes.body as any).org.id as string;

    const userRes = await userRequest('POST', '/api/users', {
      token: TEST_TOKEN,
      body: { username: 'grace', role: 'operator' },
    });
    const userId = (userRes.body as any).user.id as string;

    await userRequest('POST', `/api/orgs/${orgId}/members`, {
      token: TEST_TOKEN,
      body: { userId, role: 'operator' },
    });

    const removeRes = await userRequest('DELETE', `/api/orgs/${orgId}/members/${userId}`, {
      token: TEST_TOKEN,
    });
    expect(removeRes.statusCode).toBe(200);
    expect((removeRes.body as any).removed).toBe(true);
  });
});
