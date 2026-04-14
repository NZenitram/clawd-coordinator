import { randomUUID } from 'node:crypto';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'error';

export interface Task {
  id: string;
  agentName: string;
  prompt: string;
  sessionId?: string;
  status: TaskStatus;
  output: string[];
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export class TaskTracker {
  private tasks = new Map<string, Task>();

  create(params: { agentName: string; prompt: string; sessionId?: string }): Task {
    const task: Task = {
      id: randomUUID(),
      agentName: params.agentName,
      prompt: params.prompt,
      sessionId: params.sessionId,
      status: 'pending',
      output: [],
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

  appendOutput(id: string, data: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.output.push(data);
    }
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
}
