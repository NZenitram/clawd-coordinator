import { describe, it, expect, beforeEach } from 'vitest';
import { TaskTracker } from '../../src/coordinator/tasks.js';

describe('TaskTracker', () => {
  let tracker: TaskTracker;

  beforeEach(() => {
    tracker = new TaskTracker();
  });

  it('creates a task', () => {
    const task = tracker.create({
      agentName: 'staging-box',
      prompt: 'fix the bug',
    });
    expect(task.id).toBeDefined();
    expect(task.agentName).toBe('staging-box');
    expect(task.prompt).toBe('fix the bug');
    expect(task.status).toBe('pending');
    expect(task.output).toEqual([]);
  });

  it('gets a task by ID', () => {
    const created = tracker.create({ agentName: 'staging-box', prompt: 'test' });
    const fetched = tracker.get(created.id);
    expect(fetched).toEqual(created);
  });

  it('returns null for unknown task', () => {
    expect(tracker.get('unknown')).toBeNull();
  });

  it('transitions task to running', () => {
    const task = tracker.create({ agentName: 'staging-box', prompt: 'test' });
    tracker.setRunning(task.id);
    expect(tracker.get(task.id)!.status).toBe('running');
  });

  it('appends output to a task', () => {
    const task = tracker.create({ agentName: 'staging-box', prompt: 'test' });
    tracker.setRunning(task.id);
    tracker.appendOutput(task.id, 'line 1');
    tracker.appendOutput(task.id, 'line 2');
    expect(tracker.get(task.id)!.output).toEqual(['line 1', 'line 2']);
  });

  it('completes a task', () => {
    const task = tracker.create({ agentName: 'staging-box', prompt: 'test' });
    tracker.setRunning(task.id);
    tracker.setCompleted(task.id);
    const completed = tracker.get(task.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeDefined();
  });

  it('marks a task as errored', () => {
    const task = tracker.create({ agentName: 'staging-box', prompt: 'test' });
    tracker.setRunning(task.id);
    tracker.setError(task.id, 'something broke');
    const errored = tracker.get(task.id)!;
    expect(errored.status).toBe('error');
    expect(errored.error).toBe('something broke');
  });

  it('lists all tasks', () => {
    tracker.create({ agentName: 'a', prompt: 'p1' });
    tracker.create({ agentName: 'b', prompt: 'p2' });
    expect(tracker.list()).toHaveLength(2);
  });

  it('lists tasks filtered by status', () => {
    const t1 = tracker.create({ agentName: 'a', prompt: 'p1' });
    tracker.create({ agentName: 'b', prompt: 'p2' });
    tracker.setRunning(t1.id);
    expect(tracker.list('running')).toHaveLength(1);
    expect(tracker.list('pending')).toHaveLength(1);
  });

  it('caps output at maxOutputLines with truncation marker', () => {
    const smallTracker = new TaskTracker({ maxOutputLines: 3 });
    const task = smallTracker.create({ agentName: 'a', prompt: 'test' });
    smallTracker.setRunning(task.id);
    expect(smallTracker.appendOutput(task.id, 'line 1')).toBe(true);
    expect(smallTracker.appendOutput(task.id, 'line 2')).toBe(true);
    expect(smallTracker.appendOutput(task.id, 'line 3')).toBe(true);
    expect(smallTracker.appendOutput(task.id, 'line 4')).toBe(false);
    const updated = smallTracker.get(task.id)!;
    expect(updated.truncated).toBe(true);
    expect(updated.output).toHaveLength(4); // 3 lines + marker
    expect(updated.output[3]).toBe('[OUTPUT TRUNCATED at 3 lines]');
  });

  it('drops output after truncation without adding more lines', () => {
    const smallTracker = new TaskTracker({ maxOutputLines: 2 });
    const task = smallTracker.create({ agentName: 'a', prompt: 'test' });
    smallTracker.setRunning(task.id);
    smallTracker.appendOutput(task.id, 'line 1');
    smallTracker.appendOutput(task.id, 'line 2');
    smallTracker.appendOutput(task.id, 'line 3');
    smallTracker.appendOutput(task.id, 'line 4');
    smallTracker.appendOutput(task.id, 'line 5');
    expect(smallTracker.get(task.id)!.output).toHaveLength(3); // 2 + marker
  });

  it('creates task with default retryCount=0 maxRetries=3 deadLettered=false', () => {
    const task = tracker.create({ agentName: 'a', prompt: 'p' });
    expect(task.retryCount).toBe(0);
    expect(task.maxRetries).toBe(3);
    expect(task.deadLettered).toBe(false);
  });

  it('creates task with custom maxRetries', () => {
    const task = tracker.create({ agentName: 'a', prompt: 'p', maxRetries: 5 });
    expect(task.maxRetries).toBe(5);
  });

  it('setRetrying increments retryCount and resets status to pending', () => {
    const task = tracker.create({ agentName: 'a', prompt: 'p' });
    tracker.setRunning(task.id);
    expect(tracker.get(task.id)!.status).toBe('running');
    tracker.setRetrying(task.id);
    const updated = tracker.get(task.id)!;
    expect(updated.retryCount).toBe(1);
    expect(updated.status).toBe('pending');
  });

  it('setRetrying increments count on each call', () => {
    const task = tracker.create({ agentName: 'a', prompt: 'p' });
    tracker.setRetrying(task.id);
    tracker.setRetrying(task.id);
    expect(tracker.get(task.id)!.retryCount).toBe(2);
  });

  it('lists tasks filtered by dead-letter status', () => {
    const t1 = tracker.create({ agentName: 'a', prompt: 'p1', maxRetries: 0 });
    tracker.create({ agentName: 'b', prompt: 'p2' });
    // Manually dead-letter t1
    const raw = tracker.get(t1.id)!;
    raw.status = 'dead-letter';
    raw.deadLettered = true;
    raw.completedAt = Date.now();
    expect(tracker.list('dead-letter')).toHaveLength(1);
    expect(tracker.list('pending')).toHaveLength(1);
  });

  it('cleans up old completed tasks', () => {
    const t1 = tracker.create({ agentName: 'a', prompt: 'p1' });
    const t2 = tracker.create({ agentName: 'b', prompt: 'p2' });
    tracker.setRunning(t1.id);
    tracker.setCompleted(t1.id);
    tracker.setRunning(t2.id);

    // Backdate the completed task
    const completed = tracker.get(t1.id)!;
    completed.completedAt = Date.now() - 7200000; // 2 hours ago

    const removed = tracker.cleanup(3600000); // 1 hour threshold
    expect(removed).toBe(1);
    expect(tracker.get(t1.id)).toBeNull();
    expect(tracker.get(t2.id)).not.toBeNull();
  });
});
