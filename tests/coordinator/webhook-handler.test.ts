import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { Coordinator } from '../../src/coordinator/server.js';
import { InMemoryWebhookStore } from '../../src/coordinator/webhook-store.js';
import { serializeMessage, createAgentRegister } from '../../src/protocol/messages.js';
import WebSocket from 'ws';

const TEST_TOKEN = 'webhook-handler-test-token';
const TEST_PORT = 9887;
const BASE_URL = `http://localhost:${TEST_PORT}`;

interface HttpResponse {
  statusCode: number;
  body: unknown;
}

function request(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const bodyStr = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
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

function hmacSha256(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function connectAgent(name: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/agent`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    ws.on('open', () => {
      ws.send(serializeMessage(createAgentRegister({ name, os: 'linux', arch: 'x64' })));
      setTimeout(() => resolve(ws), 50);
    });
    ws.on('error', reject);
  });
}

describe('Webhook handler (POST /hooks/:name)', () => {
  let coordinator: Coordinator;
  let webhookStore: InMemoryWebhookStore;
  let agentWs: WebSocket;

  beforeEach(async () => {
    webhookStore = new InMemoryWebhookStore();
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN, webhookStore });
    await coordinator.start();
    agentWs = await connectAgent('ci-agent');
  });

  afterEach(async () => {
    agentWs.close();
    await coordinator.stop();
  });

  describe('basic dispatch', () => {
    it('triggers a task and returns 202 with taskId', async () => {
      webhookStore.create({
        name: 'on-push',
        agentName: 'ci-agent',
        promptTemplate: 'Run tests on {{payload.ref}}',
      });

      const res = await request('POST', '/hooks/on-push', {
        body: { ref: 'main' },
      });

      expect(res.statusCode).toBe(202);
      const body = res.body as any;
      expect(body.taskId).toBeTruthy();
      expect(body.webhook).toBe('on-push');
    });

    it('increments triggerCount on the webhook', async () => {
      webhookStore.create({
        name: 'counter-hook',
        agentName: 'ci-agent',
        promptTemplate: 'Do work',
      });

      await request('POST', '/hooks/counter-hook', { body: {} });
      await request('POST', '/hooks/counter-hook', { body: {} });

      const w = webhookStore.getByName('counter-hook');
      expect(w?.triggerCount).toBe(2);
    });

    it('renders the prompt template with payload data', async () => {
      webhookStore.create({
        name: 'template-hook',
        agentName: 'ci-agent',
        promptTemplate: 'Deploy {{payload.branch}} for {{payload.repo}}',
      });

      const res = await request('POST', '/hooks/template-hook', {
        body: { branch: 'main', repo: 'my-app' },
      });

      expect(res.statusCode).toBe(202);
    });
  });

  describe('404 for unknown webhook', () => {
    it('returns 404 when webhook name is not found', async () => {
      const res = await request('POST', '/hooks/no-such-hook', { body: {} });
      expect(res.statusCode).toBe(404);
      expect((res.body as any).error).toContain('not found');
    });
  });

  describe('HMAC signature verification', () => {
    it('accepts a request with a valid HMAC signature', async () => {
      const secret = 'test-secret-abc';
      webhookStore.create({
        name: 'secure-hook',
        agentName: 'ci-agent',
        promptTemplate: 'Secure dispatch on {{payload.ref}}',
        secret,
      });

      const bodyStr = JSON.stringify({ ref: 'main' });
      const sig = hmacSha256(secret, bodyStr);

      const res = await request('POST', '/hooks/secure-hook', {
        body: { ref: 'main' },
        headers: { 'X-Hub-Signature-256': sig },
      });

      expect(res.statusCode).toBe(202);
    });

    it('rejects a request with an invalid HMAC signature', async () => {
      webhookStore.create({
        name: 'secure-hook-bad',
        agentName: 'ci-agent',
        promptTemplate: 'test',
        secret: 'real-secret',
      });

      const res = await request('POST', '/hooks/secure-hook-bad', {
        body: { ref: 'main' },
        headers: { 'X-Hub-Signature-256': 'sha256=deadbeefdeadbeef' },
      });

      expect(res.statusCode).toBe(401);
      expect((res.body as any).error).toMatch(/Invalid HMAC/i);
    });

    it('rejects a request missing the signature header when secret is set', async () => {
      webhookStore.create({
        name: 'needs-sig',
        agentName: 'ci-agent',
        promptTemplate: 'test',
        secret: 'some-secret',
      });

      const res = await request('POST', '/hooks/needs-sig', {
        body: { ref: 'main' },
      });

      expect(res.statusCode).toBe(401);
      expect((res.body as any).error).toMatch(/Missing/i);
    });

    it('accepts requests without HMAC when no secret is configured', async () => {
      webhookStore.create({
        name: 'open-hook',
        agentName: 'ci-agent',
        promptTemplate: 'open dispatch',
      });

      const res = await request('POST', '/hooks/open-hook', { body: {} });
      expect(res.statusCode).toBe(202);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 after exceeding 10 requests per minute', async () => {
      // Use a fresh store instance for each rate limiter bucket test
      // Note: the module-level rate limiter map persists across the suite.
      // We use a unique hook name to get a fresh limiter bucket.
      const hookName = `rate-test-${Date.now()}`;
      webhookStore.create({
        name: hookName,
        agentName: 'ci-agent',
        promptTemplate: 'rate limited',
      });

      const responses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await request('POST', `/hooks/${hookName}`, { body: {} });
        responses.push(res.statusCode);
      }

      expect(responses.filter(s => s === 202)).toHaveLength(10);
      expect(responses.filter(s => s === 429).length).toBeGreaterThan(0);
    });
  });
});

describe('Webhook CRUD API (/api/webhooks)', () => {
  let coordinator: Coordinator;
  let webhookStore: InMemoryWebhookStore;

  beforeEach(async () => {
    webhookStore = new InMemoryWebhookStore();
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN, webhookStore });
    await coordinator.start();
  });

  afterEach(async () => {
    await coordinator.stop();
  });

  it('GET /api/webhooks returns empty list', async () => {
    const res = await request('GET', '/api/webhooks', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
    expect((res.body as any).webhooks).toHaveLength(0);
  });

  it('POST /api/webhooks creates a webhook', async () => {
    const res = await request('POST', '/api/webhooks', {
      token: TEST_TOKEN,
      body: { name: 'gh-hook', agentName: 'dev', promptTemplate: 'Run {{payload.ref}}' },
    });
    expect(res.statusCode).toBe(201);
    const w = (res.body as any).webhook;
    expect(w.name).toBe('gh-hook');
    expect(w.agentName).toBe('dev');
    expect(w.secret).toBeUndefined();
  });

  it('POST /api/webhooks returns 409 on duplicate name', async () => {
    await request('POST', '/api/webhooks', {
      token: TEST_TOKEN,
      body: { name: 'dup-hook', agentName: 'dev', promptTemplate: 'x' },
    });
    const res = await request('POST', '/api/webhooks', {
      token: TEST_TOKEN,
      body: { name: 'dup-hook', agentName: 'dev', promptTemplate: 'y' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /api/webhooks returns 400 for missing fields', async () => {
    const res = await request('POST', '/api/webhooks', {
      token: TEST_TOKEN,
      body: { name: 'incomplete' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toContain('Missing required fields');
  });

  it('GET /api/webhooks lists created webhooks', async () => {
    webhookStore.create({ name: 'w1', agentName: 'a', promptTemplate: 'x' });
    webhookStore.create({ name: 'w2', agentName: 'b', promptTemplate: 'y' });
    const res = await request('GET', '/api/webhooks', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
    expect((res.body as any).webhooks).toHaveLength(2);
  });

  it('DELETE /api/webhooks/:name removes webhook', async () => {
    webhookStore.create({ name: 'to-del', agentName: 'a', promptTemplate: 'x' });
    const res = await request('DELETE', '/api/webhooks/to-del', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(200);
    expect((res.body as any).deleted).toBe(true);
    expect(webhookStore.getByName('to-del')).toBeNull();
  });

  it('DELETE /api/webhooks/:name returns 404 for unknown', async () => {
    const res = await request('DELETE', '/api/webhooks/no-such', { token: TEST_TOKEN });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/webhooks/:name/test returns rendered prompt', async () => {
    webhookStore.create({
      name: 'test-hook',
      agentName: 'dev',
      promptTemplate: 'Deploy {{payload.branch}} to {{payload.env}}',
    });
    const res = await request('POST', '/api/webhooks/test-hook/test', {
      token: TEST_TOKEN,
      body: { branch: 'main', env: 'staging' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    expect(body.webhook).toBe('test-hook');
    expect(body.renderedPrompt).toBe('Deploy main to staging');
  });

  it('POST /api/webhooks/:name/test returns 404 for unknown webhook', async () => {
    const res = await request('POST', '/api/webhooks/ghost/test', {
      token: TEST_TOKEN,
      body: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth for all /api/webhooks routes', async () => {
    const res = await request('GET', '/api/webhooks');
    expect(res.statusCode).toBe(401);
  });
});
