import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { Coordinator } from '../../src/coordinator/server.js';
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
});
