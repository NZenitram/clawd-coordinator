import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryTaskQueue } from '../../src/coordinator/queue.js';

describe('InMemoryTaskQueue', () => {
  let queue: InMemoryTaskQueue;

  beforeEach(() => {
    queue = new InMemoryTaskQueue();
  });

  it('enqueues and dequeues tasks in FIFO order', () => {
    queue.enqueue('task-1');
    queue.enqueue('task-2');
    queue.enqueue('task-3');
    expect(queue.dequeue()).toBe('task-1');
    expect(queue.dequeue()).toBe('task-2');
    expect(queue.dequeue()).toBe('task-3');
  });

  it('returns null when queue is empty', () => {
    expect(queue.dequeue()).toBeNull();
  });

  it('dequeues agent-specific tasks first, then any-agent tasks', () => {
    queue.enqueue('any-1');           // any agent
    queue.enqueue('specific-1', 'agent-a'); // for agent-a
    queue.enqueue('any-2');           // any agent

    // Dequeue for agent-a: should get agent-specific first
    expect(queue.dequeue('agent-a')).toBe('specific-1');
    // Then any-agent
    expect(queue.dequeue('agent-a')).toBe('any-1');
    expect(queue.dequeue('agent-a')).toBe('any-2');
  });

  it('does not dequeue other agents tasks', () => {
    queue.enqueue('for-b', 'agent-b');
    // Dequeue for agent-a: agent-b's task should not be returned, but any-agent would be
    expect(queue.dequeue('agent-a')).toBeNull();
    // task for agent-b still there
    expect(queue.depth()).toBe(1);
    expect(queue.dequeue('agent-b')).toBe('for-b');
  });

  it('removes a queued task by id', () => {
    queue.enqueue('task-1');
    queue.enqueue('task-2');
    queue.enqueue('task-3');
    queue.remove('task-2');
    expect(queue.depth()).toBe(2);
    expect(queue.dequeue()).toBe('task-1');
    expect(queue.dequeue()).toBe('task-3');
  });

  it('returns queue depth', () => {
    expect(queue.depth()).toBe(0);
    queue.enqueue('task-1');
    queue.enqueue('task-2');
    expect(queue.depth()).toBe(2);
    queue.dequeue();
    expect(queue.depth()).toBe(1);
  });

  it('handles mixed agent-specific and any-agent dequeue correctly', () => {
    queue.enqueue('any-1');
    queue.enqueue('for-a', 'agent-a');
    queue.enqueue('for-b', 'agent-b');
    queue.enqueue('any-2');

    // Dequeue without agent name: gets first any-agent task
    expect(queue.dequeue()).toBe('any-1');
    // Dequeue for agent-b: gets agent-b specific first
    expect(queue.dequeue('agent-b')).toBe('for-b');
    // Dequeue for agent-a: gets agent-a specific
    expect(queue.dequeue('agent-a')).toBe('for-a');
    // Last any-agent task
    expect(queue.dequeue()).toBe('any-2');
    expect(queue.dequeue()).toBeNull();
  });
});
