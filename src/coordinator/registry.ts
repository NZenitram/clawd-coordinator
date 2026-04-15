export interface AgentHealth {
  claudeAvailable: boolean;
  version?: string;
}

export interface AgentInfo {
  name: string;
  os: string;
  arch: string;
  status: 'idle' | 'active' | 'busy' | 'offline';
  currentTaskIds: string[];
  maxConcurrent: number;
  health?: AgentHealth;
  connectedAt: number;
  lastHeartbeat: number;
  allowedTools?: string[];
  addDirs?: string[];
  permissionMode?: string;
}

export class AgentRegistry {
  private agents = new Map<string, AgentInfo>();

  register(name: string, meta: { os: string; arch: string; maxConcurrent?: number; allowedTools?: string[]; addDirs?: string[]; permissionMode?: string }): void {
    if (this.agents.has(name)) {
      throw new Error(`Agent "${name}" is already registered`);
    }
    const now = Date.now();
    this.agents.set(name, {
      name,
      os: meta.os,
      arch: meta.arch,
      status: 'idle',
      currentTaskIds: [],
      maxConcurrent: meta.maxConcurrent ?? 1,
      connectedAt: now,
      lastHeartbeat: now,
      allowedTools: meta.allowedTools,
      addDirs: meta.addDirs,
      permissionMode: meta.permissionMode,
    });
  }

  unregister(name: string): void {
    this.agents.delete(name);
  }

  get(name: string): AgentInfo | null {
    return this.agents.get(name) ?? null;
  }

  list(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  heartbeat(name: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.lastHeartbeat = Date.now();
    }
  }

  updateHealth(name: string, health: AgentHealth): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.health = health;
    }
  }

  hasCapacity(name: string): boolean {
    const agent = this.agents.get(name);
    if (!agent) return false;
    return agent.currentTaskIds.length < agent.maxConcurrent;
  }

  tryAddTask(name: string, taskId: string): boolean {
    const agent = this.agents.get(name);
    if (!agent || agent.currentTaskIds.length >= agent.maxConcurrent) return false;
    agent.currentTaskIds.push(taskId);
    this.updateStatus(agent);
    return true;
  }

  /** @internal Use tryAddTask for dispatch. This is only for reconnect/recovery. */
  private addTaskUnchecked(name: string, taskId: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.currentTaskIds.push(taskId);
      this.updateStatus(agent);
    }
  }

  removeTask(name: string, taskId: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.currentTaskIds = agent.currentTaskIds.filter(id => id !== taskId);
      this.updateStatus(agent);
    }
  }

  private updateStatus(agent: AgentInfo): void {
    const count = agent.currentTaskIds.length;
    if (count === 0) {
      agent.status = 'idle';
    } else if (count < agent.maxConcurrent) {
      agent.status = 'active';
    } else {
      agent.status = 'busy';
    }
  }

  getStaleAgents(thresholdMs: number): AgentInfo[] {
    const now = Date.now();
    return Array.from(this.agents.values()).filter(
      (a) => a.currentTaskIds.length === 0 && now - a.lastHeartbeat > thresholdMs
    );
  }

  getDeadBusyAgents(busyTimeoutMs: number): AgentInfo[] {
    const now = Date.now();
    return Array.from(this.agents.values()).filter(
      (a) => a.currentTaskIds.length > 0 && now - a.lastHeartbeat > busyTimeoutMs
    );
  }
}
