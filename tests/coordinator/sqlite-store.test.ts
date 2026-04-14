import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteTaskStore } from '../../src/coordinator/sqlite-store.js';

describe('SqliteTaskStore', () => {
  let store: SqliteTaskStore;

  beforeEach(async () => {
    store = await SqliteTaskStore.create(); // in-memory
  });

  afterEach(() => {
    store.close();
  });

  it('creates a task', () => {
    const task = store.create({ agentName: 'staging-box', prompt: 'fix the bug' });
    expect(task.id).toBeDefined();
    expect(task.agentName).toBe('staging-box');
    expect(task.prompt).toBe('fix the bug');
    expect(task.status).toBe('pending');
    expect(task.output).toEqual([]);
  });

  it('gets a task by ID', () => {
    const created = store.create({ agentName: 'staging-box', prompt: 'test' });
    const fetched = store.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.agentName).toBe('staging-box');
  });

  it('returns null for unknown task', () => {
    expect(store.get('unknown')).toBeNull();
  });

  it('transitions task to running', () => {
    const task = store.create({ agentName: 'staging-box', prompt: 'test' });
    store.setRunning(task.id);
    expect(store.get(task.id)!.status).toBe('running');
  });

  it('appends output to a task', () => {
    const task = store.create({ agentName: 'staging-box', prompt: 'test' });
    store.setRunning(task.id);
    store.appendOutput(task.id, 'line 1');
    store.appendOutput(task.id, 'line 2');
    expect(store.get(task.id)!.output).toEqual(['line 1', 'line 2']);
  });

  it('completes a task', () => {
    const task = store.create({ agentName: 'staging-box', prompt: 'test' });
    store.setRunning(task.id);
    store.setCompleted(task.id);
    const completed = store.get(task.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeDefined();
  });

  it('marks a task as errored', () => {
    const task = store.create({ agentName: 'staging-box', prompt: 'test' });
    store.setRunning(task.id);
    store.setError(task.id, 'something broke');
    const errored = store.get(task.id)!;
    expect(errored.status).toBe('error');
    expect(errored.error).toBe('something broke');
  });

  it('lists all tasks', () => {
    store.create({ agentName: 'a', prompt: 'p1' });
    store.create({ agentName: 'b', prompt: 'p2' });
    expect(store.list()).toHaveLength(2);
  });

  it('lists tasks filtered by status', () => {
    const t1 = store.create({ agentName: 'a', prompt: 'p1' });
    store.create({ agentName: 'b', prompt: 'p2' });
    store.setRunning(t1.id);
    expect(store.list('running')).toHaveLength(1);
    expect(store.list('pending')).toHaveLength(1);
  });

  it('caps output at maxOutputLines with truncation marker', async () => {
    const smallStore = await SqliteTaskStore.create({ maxOutputLines: 3 });
    const task = smallStore.create({ agentName: 'a', prompt: 'test' });
    smallStore.setRunning(task.id);
    expect(smallStore.appendOutput(task.id, 'line 1')).toBe(true);
    expect(smallStore.appendOutput(task.id, 'line 2')).toBe(true);
    expect(smallStore.appendOutput(task.id, 'line 3')).toBe(true);
    expect(smallStore.appendOutput(task.id, 'line 4')).toBe(false);
    const updated = smallStore.get(task.id)!;
    expect(updated.truncated).toBe(true);
    expect(updated.output).toHaveLength(4); // 3 lines + marker
    expect(updated.output[3]).toBe('[OUTPUT TRUNCATED at 3 lines]');
    smallStore.close();
  });

  it('drops output after truncation', async () => {
    const smallStore = await SqliteTaskStore.create({ maxOutputLines: 2 });
    const task = smallStore.create({ agentName: 'a', prompt: 'test' });
    smallStore.setRunning(task.id);
    smallStore.appendOutput(task.id, 'line 1');
    smallStore.appendOutput(task.id, 'line 2');
    smallStore.appendOutput(task.id, 'line 3');
    smallStore.appendOutput(task.id, 'line 4');
    expect(smallStore.get(task.id)!.output).toHaveLength(3); // 2 + marker
    smallStore.close();
  });

  it('cleans up old completed tasks', () => {
    const t1 = store.create({ agentName: 'a', prompt: 'p1' });
    const t2 = store.create({ agentName: 'b', prompt: 'p2' });
    store.setRunning(t1.id);
    store.setCompleted(t1.id);
    store.setRunning(t2.id);

    // Backdate the completed task
    store['db'].run('UPDATE tasks SET completed_at = ? WHERE id = ?', [Date.now() - 7200000, t1.id]);

    const removed = store.cleanup(3600000);
    expect(removed).toBe(1);
    expect(store.get(t1.id)).toBeNull();
    expect(store.get(t2.id)).not.toBeNull();
  });

  it('preserves traceId and sessionId', () => {
    const task = store.create({
      agentName: 'a',
      prompt: 'test',
      sessionId: 'session-1',
      traceId: 'trace-abc',
    });
    const fetched = store.get(task.id)!;
    expect(fetched.sessionId).toBe('session-1');
    expect(fetched.traceId).toBe('trace-abc');
  });

  it('recovers stale running tasks on startup', () => {
    const t1 = store.create({ agentName: 'a', prompt: 'p1' });
    const t2 = store.create({ agentName: 'b', prompt: 'p2' });
    store.setRunning(t1.id);
    store.setRunning(t2.id);
    store.setCompleted(t2.id);

    const recovered = store.recoverStaleTasks();
    expect(recovered).toBe(1);
    const t1After = store.get(t1.id)!;
    expect(t1After.status).toBe('error');
    expect(t1After.error).toContain('Coordinator restarted');
    // Completed task unaffected
    expect(store.get(t2.id)!.status).toBe('completed');
  });
});
