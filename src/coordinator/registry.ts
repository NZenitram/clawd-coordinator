export interface AgentInfo {
  name: string;
  os: string;
  arch: string;
  status: 'idle' | 'busy' | 'offline';
  currentTaskId?: string;
  connectedAt: number;
  lastHeartbeat: number;
}

export class AgentRegistry {
  private agents = new Map<string, AgentInfo>();

  register(name: string, meta: { os: string; arch: string }): void {
    if (this.agents.has(name)) {
      throw new Error(`Agent "${name}" is already registered`);
    }
    const now = Date.now();
    this.agents.set(name, {
      name,
      os: meta.os,
      arch: meta.arch,
      status: 'idle',
      connectedAt: now,
      lastHeartbeat: now,
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

  setBusy(name: string, taskId: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.status = 'busy';
      agent.currentTaskId = taskId;
    }
  }

  setIdle(name: string): void {
    const agent = this.agents.get(name);
    if (agent) {
      agent.status = 'idle';
      agent.currentTaskId = undefined;
    }
  }

  getStaleAgents(thresholdMs: number): AgentInfo[] {
    const now = Date.now();
    return Array.from(this.agents.values()).filter(
      (a) => a.status !== 'busy' && now - a.lastHeartbeat > thresholdMs
    );
  }
}
