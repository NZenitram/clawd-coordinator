export interface QueuedTask {
  taskId: string;
  agentName?: string; // undefined = any available agent
}

export interface TaskQueue {
  enqueue(taskId: string, agentName?: string): void;
  dequeue(agentName?: string): string | null;
  remove(taskId: string): void;
  depth(): number;
}

export class InMemoryTaskQueue implements TaskQueue {
  private items: QueuedTask[] = [];

  enqueue(taskId: string, agentName?: string): void {
    this.items.push({ taskId, agentName });
  }

  dequeue(agentName?: string): string | null {
    // First try agent-specific tasks
    if (agentName) {
      const agentIdx = this.items.findIndex(q => q.agentName === agentName);
      if (agentIdx !== -1) {
        return this.items.splice(agentIdx, 1)[0].taskId;
      }
    }
    // Then try any-agent tasks
    const anyIdx = this.items.findIndex(q => !q.agentName);
    if (anyIdx !== -1) {
      return this.items.splice(anyIdx, 1)[0].taskId;
    }
    return null;
  }

  remove(taskId: string): void {
    this.items = this.items.filter(q => q.taskId !== taskId);
  }

  depth(): number {
    return this.items.length;
  }
}
