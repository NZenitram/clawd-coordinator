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

  it('caps output at maxOutputLines', () => {
    const smallTracker = new TaskTracker({ maxOutputLines: 3 });
    const task = smallTracker.create({ agentName: 'a', prompt: 'test' });
    smallTracker.setRunning(task.id);
    expect(smallTracker.appendOutput(task.id, 'line 1')).toBe(true);
    expect(smallTracker.appendOutput(task.id, 'line 2')).toBe(true);
    expect(smallTracker.appendOutput(task.id, 'line 3')).toBe(true);
    expect(smallTracker.appendOutput(task.id, 'line 4')).toBe(false);
    expect(smallTracker.get(task.id)!.output).toHaveLength(3);
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
