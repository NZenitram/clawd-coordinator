import { randomUUID } from 'node:crypto';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'error';

export interface Task {
  id: string;
  agentName: string;
  prompt: string;
  sessionId?: string;
  status: TaskStatus;
  output: string[];
  truncated: boolean;
  traceId?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export class TaskTracker {
  private tasks = new Map<string, Task>();
  private maxOutputLines: number;

  constructor(options?: { maxOutputLines?: number }) {
    this.maxOutputLines = options?.maxOutputLines ?? 10000;
  }

  create(params: { agentName: string; prompt: string; sessionId?: string; traceId?: string }): Task {
    const task: Task = {
      id: randomUUID(),
      agentName: params.agentName,
      prompt: params.prompt,
      sessionId: params.sessionId,
      traceId: params.traceId,
      status: 'pending',
      output: [],
      truncated: false,
      createdAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(id: string): Task | null {
    return this.tasks.get(id) ?? null;
  }

  list(status?: TaskStatus): Task[] {
    const all = Array.from(this.tasks.values());
    if (status) {
      return all.filter(t => t.status === status);
    }
    return all;
  }

  setRunning(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = 'running';
    }
  }

  appendOutput(id: string, data: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.truncated) return false;
    if (task.output.length >= this.maxOutputLines) {
      task.truncated = true;
      task.output.push(`[OUTPUT TRUNCATED at ${this.maxOutputLines} lines]`);
      return false;
    }
    task.output.push(data);
    return true;
  }

  setCompleted(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = 'completed';
      task.completedAt = Date.now();
    }
  }

  setError(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = 'error';
      task.error = error;
      task.completedAt = Date.now();
    }
  }

  cleanup(maxAgeMs: number): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, task] of this.tasks) {
      if (
        (task.status === 'completed' || task.status === 'error') &&
        task.completedAt &&
        now - task.completedAt > maxAgeMs
      ) {
        this.tasks.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
