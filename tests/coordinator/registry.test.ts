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

  it('sets agent status to busy with task ID', () => {
    registry.register('staging-box', { os: 'linux', arch: 'x64' });
    registry.setBusy('staging-box', 'task-1');
    const agent = registry.get('staging-box')!;
    expect(agent.status).toBe('busy');
    expect(agent.currentTaskId).toBe('task-1');
  });

  it('sets agent status back to idle', () => {
    registry.register('staging-box', { os: 'linux', arch: 'x64' });
    registry.setBusy('staging-box', 'task-1');
    registry.setIdle('staging-box');
    const agent = registry.get('staging-box')!;
    expect(agent.status).toBe('idle');
    expect(agent.currentTaskId).toBeUndefined();
  });
});
