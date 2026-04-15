import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AgentInfo } from '../../coordinator/registry.js';
import type { Task } from '../../coordinator/tasks.js';

export type { AgentInfo };

export interface TaskSummary {
  id: string;
  agentName: string;
  prompt: string;
  status: string;
  createdAt: number;
  completedAt?: number;
}

export interface DashboardStats {
  queueDepth: number;
  activeTasks: number;
  completedTasks: number;
  erroredTasks: number;
  connectedAgents: number;
}

export interface DashboardData {
  agents: AgentInfo[];
  tasks: TaskSummary[];
  stats: DashboardStats;
}

/** Default empty dashboard data used when fetch fails. */
export const EMPTY_DASHBOARD_DATA: DashboardData = {
  agents: [],
  tasks: [],
  stats: { queueDepth: 0, activeTasks: 0, completedTasks: 0, erroredTasks: 0, connectedAgents: 0 },
};

function fetchJson(url: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const requester = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requester(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(new Error(`Failed to parse JSON from ${url}: ${err}`));
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error(`Request to ${url} timed out`)); });
    req.end();
  });
}

function taskToSummary(task: Task): TaskSummary {
  return {
    id: task.id,
    agentName: task.agentName,
    prompt: task.prompt,
    status: task.status,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
  };
}

export async function fetchDashboardData(baseUrl: string, token: string): Promise<DashboardData> {
  // Normalize base URL — strip trailing slash
  const base = baseUrl.replace(/\/$/, '');

  const [agentsResult, tasksResult, statsResult] = await Promise.allSettled([
    fetchJson(`${base}/api/agents`, token),
    fetchJson(`${base}/api/tasks`, token),
    fetchJson(`${base}/api/stats`, token),
  ]);

  const agents: AgentInfo[] =
    agentsResult.status === 'fulfilled' &&
    typeof agentsResult.value === 'object' &&
    agentsResult.value !== null &&
    Array.isArray((agentsResult.value as Record<string, unknown>).agents)
      ? ((agentsResult.value as Record<string, unknown>).agents as AgentInfo[])
      : [];

  const rawTasks: Task[] =
    tasksResult.status === 'fulfilled' &&
    typeof tasksResult.value === 'object' &&
    tasksResult.value !== null &&
    Array.isArray((tasksResult.value as Record<string, unknown>).tasks)
      ? ((tasksResult.value as Record<string, unknown>).tasks as Task[])
      : [];

  const tasks: TaskSummary[] = rawTasks.map(taskToSummary);

  let stats: DashboardStats = { queueDepth: 0, activeTasks: 0, completedTasks: 0, erroredTasks: 0, connectedAgents: 0 };
  if (
    statsResult.status === 'fulfilled' &&
    typeof statsResult.value === 'object' &&
    statsResult.value !== null
  ) {
    const raw = (statsResult.value as Record<string, unknown>).stats;
    if (typeof raw === 'object' && raw !== null) {
      const s = raw as Record<string, unknown>;
      stats = {
        queueDepth: typeof s.queueDepth === 'number' ? s.queueDepth : 0,
        activeTasks: typeof s.activeTasks === 'number' ? s.activeTasks : 0,
        completedTasks: typeof s.tasksCompleted === 'number' ? s.tasksCompleted : 0,
        erroredTasks: typeof s.tasksErrored === 'number' ? s.tasksErrored : 0,
        connectedAgents: typeof s.connectedAgents === 'number' ? s.connectedAgents : 0,
      };
    }
  }

  return { agents, tasks, stats };
}

/** Format milliseconds since epoch as a human-readable age string. */
export function formatAge(createdAt: number): string {
  const ageMs = Date.now() - createdAt;
  const secs = Math.floor(ageMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h`;
}
