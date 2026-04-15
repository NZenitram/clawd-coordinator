import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector } from '../../src/shared/metrics.js';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    // Use a fresh collector per test so metrics don't bleed between tests
    collector = new MetricsCollector();
  });

  // ── Counter increments ──────────────────────────────────────────────────────

  it('tasksDispatched starts at 0', () => {
    const stats = collector.getStats();
    expect(stats.tasksDispatched).toBe(0);
  });

  it('incDispatched increments tasksDispatched', () => {
    collector.incDispatched();
    collector.incDispatched();
    expect(collector.getStats().tasksDispatched).toBe(2);
  });

  it('tasksCompleted starts at 0 and increments', () => {
    expect(collector.getStats().tasksCompleted).toBe(0);
    collector.incCompleted();
    expect(collector.getStats().tasksCompleted).toBe(1);
  });

  it('tasksErrored starts at 0 and increments', () => {
    expect(collector.getStats().tasksErrored).toBe(0);
    collector.incErrored();
    collector.incErrored();
    expect(collector.getStats().tasksErrored).toBe(2);
  });

  // ── Gauge set / inc / dec ───────────────────────────────────────────────────

  it('connectedAgents starts at 0', () => {
    expect(collector.getStats().connectedAgents).toBe(0);
  });

  it('incConnectedAgents increments connectedAgents', () => {
    collector.incConnectedAgents();
    collector.incConnectedAgents();
    expect(collector.getStats().connectedAgents).toBe(2);
  });

  it('decConnectedAgents decrements connectedAgents', () => {
    collector.incConnectedAgents();
    collector.incConnectedAgents();
    collector.decConnectedAgents();
    expect(collector.getStats().connectedAgents).toBe(1);
  });

  it('decConnectedAgents does not go below 0', () => {
    collector.decConnectedAgents();
    expect(collector.getStats().connectedAgents).toBe(0);
  });

  it('setQueueDepth sets queueDepth', () => {
    collector.setQueueDepth(5);
    expect(collector.getStats().queueDepth).toBe(5);
    collector.setQueueDepth(0);
    expect(collector.getStats().queueDepth).toBe(0);
  });

  it('setActiveTasks sets activeTasks', () => {
    collector.setActiveTasks(3);
    expect(collector.getStats().activeTasks).toBe(3);
  });

  // ── getStats returns expected shape ─────────────────────────────────────────

  it('getStats returns object with all expected keys', () => {
    const stats = collector.getStats();
    const keys: (keyof typeof stats)[] = [
      'tasksDispatched',
      'tasksCompleted',
      'tasksErrored',
      'connectedAgents',
      'queueDepth',
      'activeTasks',
    ];
    for (const key of keys) {
      expect(typeof stats[key]).toBe('number');
    }
  });

  it('getStats reflects multiple counter increments', () => {
    collector.incDispatched();
    collector.incDispatched();
    collector.incCompleted();
    collector.incErrored();
    collector.incConnectedAgents();
    collector.setQueueDepth(4);
    collector.setActiveTasks(1);

    const stats = collector.getStats();
    expect(stats.tasksDispatched).toBe(2);
    expect(stats.tasksCompleted).toBe(1);
    expect(stats.tasksErrored).toBe(1);
    expect(stats.connectedAgents).toBe(1);
    expect(stats.queueDepth).toBe(4);
    expect(stats.activeTasks).toBe(1);
  });

  // ── Duration tracking ───────────────────────────────────────────────────────

  it('observeTaskDuration does not throw for unknown taskId', () => {
    expect(() => collector.observeTaskDuration('nonexistent')).not.toThrow();
  });

  it('recordTaskStart + observeTaskDuration records a value without error', () => {
    collector.recordTaskStart('task-1');
    // A tiny delay to ensure non-zero duration
    expect(() => collector.observeTaskDuration('task-1')).not.toThrow();
  });

  it('observeTaskDuration cleans up start time so second call is a no-op', () => {
    collector.recordTaskStart('task-2');
    collector.observeTaskDuration('task-2');
    // Second observation should silently do nothing (no recorded start)
    expect(() => collector.observeTaskDuration('task-2')).not.toThrow();
  });

  // ── Prometheus registry ─────────────────────────────────────────────────────

  it('registry.metrics() returns a non-empty string with metric names', async () => {
    collector.incDispatched();
    const output = await collector.registry.metrics();
    expect(typeof output).toBe('string');
    expect(output).toContain('coord_tasks_dispatched_total');
    expect(output).toContain('coord_tasks_completed_total');
    expect(output).toContain('coord_tasks_errored_total');
    expect(output).toContain('coord_task_duration_seconds');
    expect(output).toContain('coord_connected_agents');
    expect(output).toContain('coord_queue_depth');
    expect(output).toContain('coord_active_tasks');
  });
});
