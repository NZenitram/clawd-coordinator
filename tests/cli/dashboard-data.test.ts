import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fetchDashboardData, formatAge, EMPTY_DASHBOARD_DATA } from '../../src/cli/dashboard/data.js';
import type { AgentInfo } from '../../src/coordinator/registry.js';
import type { Task } from '../../src/coordinator/tasks.js';

const TEST_TOKEN = 'test-dash-token-xyz';
const TEST_PORT = 19877;

// ---------------------------------------------------------------------------
// Minimal HTTP mock server
// ---------------------------------------------------------------------------

type RouteHandler = (res: ServerResponse) => void;

function createMockServer(routes: Record<string, RouteHandler>): http.Server {
  return http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    const handler = routes[path];
    if (handler) {
      handler(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
}

function sendJson(res: ServerResponse, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(json)) });
  res.end(json);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_FIXTURE: AgentInfo = {
  name: 'test-agent',
  os: 'linux',
  arch: 'x64',
  status: 'idle',
  currentTaskIds: [],
  maxConcurrent: 1,
  connectedAt: Date.now() - 60000,
  lastHeartbeat: Date.now() - 5000,
};

const TASK_FIXTURE: Task = {
  id: 'task-abc123',
  agentName: 'test-agent',
  prompt: 'do something useful',
  status: 'running',
  output: [],
  truncated: false,
  createdAt: Date.now() - 30000,
  retryCount: 0,
  maxRetries: 3,
  deadLettered: false,
};

const STATS_FIXTURE = {
  tasksDispatched: 5,
  tasksCompleted: 3,
  tasksErrored: 1,
  connectedAgents: 1,
  queueDepth: 0,
  activeTasks: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchDashboardData', () => {
  let server: http.Server;
  const baseUrl = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    server = createMockServer({
      '/api/agents': (res) => sendJson(res, { agents: [AGENT_FIXTURE] }),
      '/api/tasks': (res) => sendJson(res, { tasks: [TASK_FIXTURE] }),
      '/api/stats': (res) => sendJson(res, { stats: STATS_FIXTURE }),
    });

    await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('returns agents from /api/agents', async () => {
    const data = await fetchDashboardData(baseUrl, TEST_TOKEN);
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].name).toBe('test-agent');
    expect(data.agents[0].status).toBe('idle');
  });

  it('returns task summaries from /api/tasks', async () => {
    const data = await fetchDashboardData(baseUrl, TEST_TOKEN);
    expect(data.tasks).toHaveLength(1);
    const task = data.tasks[0];
    expect(task.id).toBe('task-abc123');
    expect(task.agentName).toBe('test-agent');
    expect(task.prompt).toBe('do something useful');
    expect(task.status).toBe('running');
    expect(typeof task.createdAt).toBe('number');
  });

  it('normalizes stats from /api/stats', async () => {
    const data = await fetchDashboardData(baseUrl, TEST_TOKEN);
    const s = data.stats;
    expect(s.connectedAgents).toBe(1);
    expect(s.queueDepth).toBe(0);
    expect(s.activeTasks).toBe(1);
    expect(s.completedTasks).toBe(3);
    expect(s.erroredTasks).toBe(1);
  });

  it('does not expose raw output array on task summaries', async () => {
    const data = await fetchDashboardData(baseUrl, TEST_TOKEN);
    const task = data.tasks[0];
    expect((task as unknown as Record<string, unknown>)['output']).toBeUndefined();
  });
});

describe('fetchDashboardData — error resilience', () => {
  let server: http.Server;
  const failPort = TEST_PORT + 1;
  const baseUrl = `http://localhost:${failPort}`;

  beforeAll(async () => {
    // Agents returns an error; tasks and stats return valid data
    server = createMockServer({
      '/api/agents': (res) => { res.writeHead(500); res.end('{}'); },
      '/api/tasks': (res) => sendJson(res, { tasks: [] }),
      '/api/stats': (res) => sendJson(res, { stats: STATS_FIXTURE }),
    });
    await new Promise<void>((resolve) => server.listen(failPort, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('returns empty agents array when /api/agents responds with non-array', async () => {
    const data = await fetchDashboardData(baseUrl, TEST_TOKEN);
    expect(data.agents).toEqual([]);
  });

  it('still returns stats when agents endpoint fails', async () => {
    const data = await fetchDashboardData(baseUrl, TEST_TOKEN);
    expect(data.stats.connectedAgents).toBe(1);
  });
});

describe('fetchDashboardData — unreachable server', () => {
  it('returns empty data when the server is not reachable (graceful degradation)', async () => {
    // Port 1 is not listening; all three parallel requests will fail.
    // fetchDashboardData uses Promise.allSettled so it degrades gracefully
    // instead of throwing.
    const data = await fetchDashboardData('http://localhost:1', TEST_TOKEN);
    expect(data.agents).toEqual([]);
    expect(data.tasks).toEqual([]);
    expect(data.stats.queueDepth).toBe(0);
    expect(data.stats.connectedAgents).toBe(0);
  });
});

describe('EMPTY_DASHBOARD_DATA', () => {
  it('is a valid DashboardData with zero values', () => {
    expect(EMPTY_DASHBOARD_DATA.agents).toEqual([]);
    expect(EMPTY_DASHBOARD_DATA.tasks).toEqual([]);
    expect(EMPTY_DASHBOARD_DATA.stats.queueDepth).toBe(0);
    expect(EMPTY_DASHBOARD_DATA.stats.activeTasks).toBe(0);
    expect(EMPTY_DASHBOARD_DATA.stats.completedTasks).toBe(0);
    expect(EMPTY_DASHBOARD_DATA.stats.erroredTasks).toBe(0);
    expect(EMPTY_DASHBOARD_DATA.stats.connectedAgents).toBe(0);
  });
});

describe('formatAge', () => {
  it('returns seconds for recent timestamps', () => {
    const result = formatAge(Date.now() - 10000);
    expect(result).toMatch(/^\d+s$/);
  });

  it('returns minutes for timestamps 1-60 minutes ago', () => {
    const result = formatAge(Date.now() - 5 * 60 * 1000);
    expect(result).toBe('5m');
  });

  it('returns hours for timestamps over 60 minutes ago', () => {
    const result = formatAge(Date.now() - 2 * 60 * 60 * 1000);
    expect(result).toBe('2h');
  });

  it('handles zero age (just now)', () => {
    const result = formatAge(Date.now());
    expect(result).toMatch(/^\d+s$/);
  });
});
