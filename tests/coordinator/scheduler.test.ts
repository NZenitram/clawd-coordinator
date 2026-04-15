import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { InMemoryScheduleStore, Scheduler, validateCronExpression, type DispatchFn } from '../../src/coordinator/scheduler.js';

describe('validateCronExpression', () => {
  it('accepts a valid standard 5-field cron expression', () => {
    expect(validateCronExpression('0 6 * * *')).toBeNull();
  });

  it('accepts "* * * * *" (every minute)', () => {
    expect(validateCronExpression('* * * * *')).toBeNull();
  });

  it('rejects an invalid expression', () => {
    const err = validateCronExpression('not a cron');
    expect(err).not.toBeNull();
    expect(typeof err).toBe('string');
  });

  it('rejects an empty string', () => {
    const err = validateCronExpression('');
    expect(err).not.toBeNull();
  });
});

describe('InMemoryScheduleStore', () => {
  let store: InMemoryScheduleStore;

  beforeEach(() => {
    store = new InMemoryScheduleStore();
  });

  it('creates a schedule with required fields', () => {
    const s = store.create({ cronExpr: '0 6 * * *', agentName: 'ops', prompt: 'run health check' });
    expect(s.id).toBeDefined();
    expect(s.cronExpr).toBe('0 6 * * *');
    expect(s.agentName).toBe('ops');
    expect(s.prompt).toBe('run health check');
    expect(s.paused).toBe(false);
    expect(s.runCount).toBe(0);
    expect(s.createdAt).toBeGreaterThan(0);
    expect(s.nextRunAt).toBeDefined();
  });

  it('throws on invalid cron expression', () => {
    expect(() => store.create({ cronExpr: 'bogus', agentName: 'ops', prompt: 'test' })).toThrow();
  });

  it('stores optional fields', () => {
    const s = store.create({
      cronExpr: '*/5 * * * *',
      agentName: 'dev',
      prompt: 'check deps',
      budgetUsd: 1.5,
      allowedTools: ['Read', 'Bash'],
      orgId: 'org-123',
    });
    expect(s.budgetUsd).toBe(1.5);
    expect(s.allowedTools).toEqual(['Read', 'Bash']);
    expect(s.orgId).toBe('org-123');
  });

  it('gets a schedule by id', () => {
    const created = store.create({ cronExpr: '0 0 * * *', agentName: 'a', prompt: 'p' });
    const fetched = store.get(created.id);
    expect(fetched).toEqual(created);
  });

  it('returns null for unknown id', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  it('lists all schedules', () => {
    store.create({ cronExpr: '0 6 * * *', agentName: 'a', prompt: 'p1' });
    store.create({ cronExpr: '0 12 * * *', agentName: 'b', prompt: 'p2' });
    expect(store.list()).toHaveLength(2);
  });

  it('lists schedules filtered by orgId', () => {
    store.create({ cronExpr: '0 6 * * *', agentName: 'a', prompt: 'p1', orgId: 'org-1' });
    store.create({ cronExpr: '0 12 * * *', agentName: 'b', prompt: 'p2', orgId: 'org-2' });
    expect(store.list('org-1')).toHaveLength(1);
    expect(store.list('org-1')[0].agentName).toBe('a');
  });

  it('deletes a schedule by id', () => {
    const s = store.create({ cronExpr: '0 6 * * *', agentName: 'a', prompt: 'p' });
    store.delete(s.id);
    expect(store.get(s.id)).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it('ignores delete for unknown id', () => {
    store.create({ cronExpr: '0 6 * * *', agentName: 'a', prompt: 'p' });
    store.delete('unknown-id');
    expect(store.list()).toHaveLength(1);
  });

  it('sets paused to true', () => {
    const s = store.create({ cronExpr: '0 6 * * *', agentName: 'a', prompt: 'p' });
    store.setPaused(s.id, true);
    expect(store.get(s.id)!.paused).toBe(true);
  });

  it('sets paused to false (resume)', () => {
    const s = store.create({ cronExpr: '0 6 * * *', agentName: 'a', prompt: 'p' });
    store.setPaused(s.id, true);
    store.setPaused(s.id, false);
    expect(store.get(s.id)!.paused).toBe(false);
  });

  it('records a run — increments runCount, updates lastRunAt', () => {
    const s = store.create({ cronExpr: '0 6 * * *', agentName: 'a', prompt: 'p' });
    const beforeTs = Date.now();
    store.recordRun(s.id, Date.now() + 86400_000);
    const updated = store.get(s.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastRunAt).toBeGreaterThanOrEqual(beforeTs);
    expect(updated.nextRunAt).toBeGreaterThan(beforeTs);
  });

  it('recordRun with undefined nextRunAt clears nextRunAt', () => {
    const s = store.create({ cronExpr: '0 6 * * *', agentName: 'a', prompt: 'p' });
    store.recordRun(s.id, undefined);
    expect(store.get(s.id)!.nextRunAt).toBeUndefined();
  });

  it('updateNextRunAt sets the nextRunAt field', () => {
    const s = store.create({ cronExpr: '0 6 * * *', agentName: 'a', prompt: 'p' });
    store.updateNextRunAt(s.id, 9999);
    expect(store.get(s.id)!.nextRunAt).toBe(9999);
  });
});

describe('Scheduler', () => {
  let store: InMemoryScheduleStore;
  let dispatched: Array<{ agentName: string; prompt: string; options?: unknown }>;
  let dispatchFn: DispatchFn;
  let scheduler: Scheduler;

  beforeEach(() => {
    store = new InMemoryScheduleStore();
    dispatched = [];
    dispatchFn = (agentName, prompt, options) => {
      dispatched.push({ agentName, prompt, options });
    };
    scheduler = new Scheduler(store, dispatchFn);
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('dispatches a schedule whose nextRunAt is in the past', () => {
    const s = store.create({ cronExpr: '* * * * *', agentName: 'ops', prompt: 'check' });
    // Force nextRunAt to the past
    store.updateNextRunAt(s.id, Date.now() - 1000);

    scheduler.tick();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].agentName).toBe('ops');
    expect(dispatched[0].prompt).toBe('check');
  });

  it('does not dispatch a schedule whose nextRunAt is in the future', () => {
    const s = store.create({ cronExpr: '* * * * *', agentName: 'ops', prompt: 'check' });
    store.updateNextRunAt(s.id, Date.now() + 60_000);

    scheduler.tick();

    expect(dispatched).toHaveLength(0);
  });

  it('skips paused schedules', () => {
    const s = store.create({ cronExpr: '* * * * *', agentName: 'ops', prompt: 'check' });
    store.updateNextRunAt(s.id, Date.now() - 1000);
    store.setPaused(s.id, true);

    scheduler.tick();

    expect(dispatched).toHaveLength(0);
  });

  it('increments runCount after dispatch', () => {
    const s = store.create({ cronExpr: '* * * * *', agentName: 'ops', prompt: 'check' });
    store.updateNextRunAt(s.id, Date.now() - 1000);

    scheduler.tick();

    expect(store.get(s.id)!.runCount).toBe(1);
  });

  it('computes a future nextRunAt after dispatch', () => {
    const s = store.create({ cronExpr: '* * * * *', agentName: 'ops', prompt: 'check' });
    store.updateNextRunAt(s.id, Date.now() - 1000);

    scheduler.tick();

    const updated = store.get(s.id)!;
    // nextRunAt should now be in the future (or undefined if cron exhausted)
    if (updated.nextRunAt !== undefined) {
      expect(updated.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    }
  });

  it('passes budgetUsd and allowedTools to dispatchFn', () => {
    const s = store.create({
      cronExpr: '* * * * *',
      agentName: 'ops',
      prompt: 'check',
      budgetUsd: 2.5,
      allowedTools: ['Read'],
    });
    store.updateNextRunAt(s.id, Date.now() - 1000);

    scheduler.tick();

    expect(dispatched[0].options).toMatchObject({ budgetUsd: 2.5, allowedTools: ['Read'] });
  });

  it('dispatches multiple due schedules in one tick', () => {
    const s1 = store.create({ cronExpr: '* * * * *', agentName: 'a1', prompt: 'p1' });
    const s2 = store.create({ cronExpr: '* * * * *', agentName: 'a2', prompt: 'p2' });
    store.updateNextRunAt(s1.id, Date.now() - 2000);
    store.updateNextRunAt(s2.id, Date.now() - 1000);

    scheduler.tick();

    expect(dispatched).toHaveLength(2);
  });

  it('continues running other schedules even if one dispatchFn throws', () => {
    let callCount = 0;
    const throwingDispatch: DispatchFn = (agentName) => {
      callCount++;
      if (agentName === 'a1') throw new Error('dispatch failed');
    };
    const throwScheduler = new Scheduler(store, throwingDispatch);

    const s1 = store.create({ cronExpr: '* * * * *', agentName: 'a1', prompt: 'p1' });
    const s2 = store.create({ cronExpr: '* * * * *', agentName: 'a2', prompt: 'p2' });
    store.updateNextRunAt(s1.id, Date.now() - 2000);
    store.updateNextRunAt(s2.id, Date.now() - 1000);

    expect(() => throwScheduler.tick()).not.toThrow();
    expect(callCount).toBe(2);
    throwScheduler.stop();
  });

  it('start() sets up interval timer and stop() clears it', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const fresh = new Scheduler(store, dispatchFn);
    fresh.start();
    expect(setIntervalSpy).toHaveBeenCalledOnce();

    fresh.stop();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();

    vi.useRealTimers();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('start() recomputes nextRunAt for existing schedules', () => {
    // Create schedule with no nextRunAt (simulate fresh store after restart)
    const s = store.create({ cronExpr: '* * * * *', agentName: 'ops', prompt: 'check' });
    // Override nextRunAt to simulate it being lost
    store.updateNextRunAt(s.id, 0);

    vi.useFakeTimers();
    const fresh = new Scheduler(store, dispatchFn);
    fresh.start();
    fresh.stop();
    vi.useRealTimers();

    // After start(), nextRunAt should be recomputed to a real future timestamp
    const updated = store.get(s.id)!;
    expect(updated.nextRunAt).toBeGreaterThan(Date.now() - 1000);
  });
});
