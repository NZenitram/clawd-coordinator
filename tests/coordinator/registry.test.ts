import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '../../src/coordinator/registry.js';

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it('registers an agent', () => {
    registry.register('staging-box', { os: 'linux', arch: 'x64' });
    const agents = registry.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('staging-box');
    expect(agents[0].status).toBe('idle');
    expect(agents[0].os).toBe('linux');
    expect(agents[0].arch).toBe('x64');
    expect(agents[0].maxConcurrent).toBe(1);
    expect(agents[0].currentTaskIds).toEqual([]);
  });

  it('registers an agent with custom maxConcurrent', () => {
    registry.register('big-box', { os: 'linux', arch: 'x64', maxConcurrent: 4 });
    const agent = registry.get('big-box')!;
    expect(agent.maxConcurrent).toBe(4);
  });

  it('rejects duplicate agent names', () => {
    registry.register('staging-box', { os: 'linux', arch: 'x64' });
    expect(() => registry.register('staging-box', { os: 'linux', arch: 'x64' }))
      .toThrow('Agent "staging-box" is already registered');
  });

  it('unregisters an agent', () => {
    registry.register('staging-box', { os: 'linux', arch: 'x64' });
    registry.unregister('staging-box');
    expect(registry.list()).toHaveLength(0);
  });

  it('gets a specific agent', () => {
    registry.register('staging-box', { os: 'linux', arch: 'x64' });
    const agent = registry.get('staging-box');
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe('staging-box');
  });

  it('returns null for unknown agent', () => {
    expect(registry.get('unknown')).toBeNull();
  });

  it('updates heartbeat timestamp', () => {
    registry.register('staging-box', { os: 'linux', arch: 'x64' });
    const before = registry.get('staging-box')!.lastHeartbeat;
    registry.heartbeat('staging-box');
    const after = registry.get('staging-box')!.lastHeartbeat;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('adds a task and transitions to busy (maxConcurrent=1)', () => {
    registry.register('staging-box', { os: 'linux', arch: 'x64' });
    registry.tryAddTask('staging-box', 'task-1');
    const agent = registry.get('staging-box')!;
    expect(agent.status).toBe('busy');
    expect(agent.currentTaskIds).toEqual(['task-1']);
  });

  it('removes a task and transitions back to idle', () => {
    registry.register('staging-box', { os: 'linux', arch: 'x64' });
    registry.tryAddTask('staging-box', 'task-1');
    registry.removeTask('staging-box', 'task-1');
    const agent = registry.get('staging-box')!;
    expect(agent.status).toBe('idle');
    expect(agent.currentTaskIds).toEqual([]);
  });

  it('tracks multiple concurrent tasks per agent', () => {
    registry.register('multi-agent', { os: 'linux', arch: 'x64', maxConcurrent: 3 });
    registry.tryAddTask('multi-agent', 'task-1');
    registry.tryAddTask('multi-agent', 'task-2');
    const agent = registry.get('multi-agent')!;
    expect(agent.currentTaskIds).toEqual(['task-1', 'task-2']);
    expect(agent.status).toBe('active'); // has capacity
    registry.tryAddTask('multi-agent', 'task-3');
    expect(registry.get('multi-agent')!.status).toBe('busy'); // at capacity
  });

  it('hasCapacity returns true when agent has room', () => {
    registry.register('cap-agent', { os: 'linux', arch: 'x64', maxConcurrent: 2 });
    expect(registry.hasCapacity('cap-agent')).toBe(true);
    registry.tryAddTask('cap-agent', 'task-1');
    expect(registry.hasCapacity('cap-agent')).toBe(true);
    registry.tryAddTask('cap-agent', 'task-2');
    expect(registry.hasCapacity('cap-agent')).toBe(false);
  });

  it('hasCapacity returns false for unknown agent', () => {
    expect(registry.hasCapacity('ghost')).toBe(false);
  });

  it('tryAddTask atomically checks and claims capacity', () => {
    registry.register('atomic-agent', { os: 'linux', arch: 'x64', maxConcurrent: 2 });
    expect(registry.tryAddTask('atomic-agent', 'task-1')).toBe(true);
    expect(registry.tryAddTask('atomic-agent', 'task-2')).toBe(true);
    expect(registry.tryAddTask('atomic-agent', 'task-3')).toBe(false); // at capacity
    expect(registry.get('atomic-agent')!.currentTaskIds).toEqual(['task-1', 'task-2']);
  });

  it('tryAddTask returns false for unknown agent', () => {
    expect(registry.tryAddTask('ghost', 'task-1')).toBe(false);
  });

  it('updates agent health status', () => {
    registry.register('health-agent', { os: 'linux', arch: 'x64' });
    expect(registry.get('health-agent')!.health).toBeUndefined();

    registry.updateHealth('health-agent', { claudeAvailable: true, version: 'claude 1.0.0' });
    const agent = registry.get('health-agent')!;
    expect(agent.health?.claudeAvailable).toBe(true);
    expect(agent.health?.version).toBe('claude 1.0.0');

    registry.updateHealth('health-agent', { claudeAvailable: false });
    expect(registry.get('health-agent')!.health?.claudeAvailable).toBe(false);
  });

  it('detects stale agents based on heartbeat threshold', () => {
    registry.register('fresh-agent', { os: 'linux', arch: 'x64' });
    registry.register('stale-agent', { os: 'linux', arch: 'x64' });

    const stale = registry.get('stale-agent')!;
    stale.lastHeartbeat = Date.now() - 120000;

    const staleAgents = registry.getStaleAgents(90000);
    expect(staleAgents).toHaveLength(1);
    expect(staleAgents[0].name).toBe('stale-agent');
  });

  it('detects dead busy agents', () => {
    registry.register('working-agent', { os: 'linux', arch: 'x64' });
    registry.tryAddTask('working-agent', 'task-1');
    const agent = registry.get('working-agent')!;
    agent.lastHeartbeat = Date.now() - 600000;

    const dead = registry.getDeadBusyAgents(300000);
    expect(dead).toHaveLength(1);
    expect(dead[0].name).toBe('working-agent');
  });

  it('does not flag recently active busy agents', () => {
    registry.register('active-agent', { os: 'linux', arch: 'x64' });
    registry.tryAddTask('active-agent', 'task-1');

    const dead = registry.getDeadBusyAgents(300000);
    expect(dead).toHaveLength(0);
  });

  it('excludes busy agents from staleness check', () => {
    registry.register('busy-agent', { os: 'linux', arch: 'x64' });
    registry.tryAddTask('busy-agent', 'task-1');

    const agent = registry.get('busy-agent')!;
    agent.lastHeartbeat = Date.now() - 120000;

    const staleAgents = registry.getStaleAgents(90000);
    expect(staleAgents).toHaveLength(0);
  });

  // --- Pool tests ---

  it('getPoolAgents returns only agents in the given pool', () => {
    registry.register('pool-a-1', { os: 'linux', arch: 'x64', pool: 'staging' });
    registry.register('pool-a-2', { os: 'linux', arch: 'x64', pool: 'staging' });
    registry.register('pool-b-1', { os: 'linux', arch: 'x64', pool: 'production' });
    registry.register('no-pool', { os: 'linux', arch: 'x64' });

    const staging = registry.getPoolAgents('staging');
    expect(staging).toHaveLength(2);
    expect(staging.map(a => a.name).sort()).toEqual(['pool-a-1', 'pool-a-2']);

    const production = registry.getPoolAgents('production');
    expect(production).toHaveLength(1);
    expect(production[0].name).toBe('pool-b-1');

    expect(registry.getPoolAgents('nonexistent')).toHaveLength(0);
  });

  it('pickFromPool returns the least-loaded agent with capacity', () => {
    registry.register('agent-a', { os: 'linux', arch: 'x64', pool: 'test-pool', maxConcurrent: 2 });
    registry.register('agent-b', { os: 'linux', arch: 'x64', pool: 'test-pool', maxConcurrent: 2 });

    // Both idle — picks the one with most recent heartbeat (both equal, first wins)
    const first = registry.pickFromPool('test-pool');
    expect(first).not.toBeNull();

    // Give agent-a a task so agent-b has lower load
    registry.tryAddTask('agent-a', 'task-1');
    const picked = registry.pickFromPool('test-pool');
    expect(picked).not.toBeNull();
    expect(picked!.name).toBe('agent-b');
  });

  it('pickFromPool returns null when no agents have capacity', () => {
    registry.register('full-agent', { os: 'linux', arch: 'x64', pool: 'full-pool', maxConcurrent: 1 });
    registry.tryAddTask('full-agent', 'task-1');

    expect(registry.pickFromPool('full-pool')).toBeNull();
  });

  it('pickFromPool ignores agents not in the requested pool', () => {
    registry.register('other-pool-agent', { os: 'linux', arch: 'x64', pool: 'other' });
    registry.register('no-pool-agent', { os: 'linux', arch: 'x64' });

    expect(registry.pickFromPool('my-pool')).toBeNull();
  });

  it('stores pool field on registered agent', () => {
    registry.register('pooled', { os: 'linux', arch: 'x64', pool: 'mypool' });
    const agent = registry.get('pooled')!;
    expect(agent.pool).toBe('mypool');
  });

  it('pickFromPool tiebreaks by most recent heartbeat', () => {
    registry.register('agent-old', { os: 'linux', arch: 'x64', pool: 'hb-pool', maxConcurrent: 2 });
    registry.register('agent-new', { os: 'linux', arch: 'x64', pool: 'hb-pool', maxConcurrent: 2 });

    // Manually set heartbeats so agent-new has the most recent
    registry.get('agent-old')!.lastHeartbeat = Date.now() - 10000;
    registry.get('agent-new')!.lastHeartbeat = Date.now();

    // Equal load (both idle), agent-new should win
    const picked = registry.pickFromPool('hb-pool');
    expect(picked!.name).toBe('agent-new');
  });
});
