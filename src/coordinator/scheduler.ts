import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';

export interface Schedule {
  id: string;
  cronExpr: string;
  agentName: string;
  prompt: string;
  paused: boolean;
  budgetUsd?: number;
  allowedTools?: string[];
  orgId?: string;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
}

export interface CreateScheduleParams {
  cronExpr: string;
  agentName: string;
  prompt: string;
  budgetUsd?: number;
  allowedTools?: string[];
  orgId?: string;
}

export interface ScheduleStore {
  create(params: CreateScheduleParams): Schedule;
  get(id: string): Schedule | null;
  list(orgId?: string): Schedule[];
  delete(id: string): void;
  setPaused(id: string, paused: boolean): void;
  recordRun(id: string, nextRunAt?: number): void;
  updateNextRunAt(id: string, nextRunAt: number): void;
}

export interface DispatchOptions {
  budgetUsd?: number;
  allowedTools?: string[];
  orgId?: string;
}

export type DispatchFn = (agentName: string, prompt: string, options?: DispatchOptions) => void;

/** Validates a cron expression using croner. Returns an error string or null if valid. */
export function validateCronExpression(expr: string): string | null {
  try {
    new Cron(expr, { maxRuns: 0 });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid cron expression';
  }
}

/** Compute the next run Date for a cron expression, or null if exhausted. */
function computeNextRun(cronExpr: string): Date | null {
  try {
    const job = new Cron(cronExpr, { maxRuns: 1 });
    return job.nextRun() ?? null;
  } catch {
    return null;
  }
}

export class InMemoryScheduleStore implements ScheduleStore {
  private schedules = new Map<string, Schedule>();

  create(params: CreateScheduleParams): Schedule {
    const validationError = validateCronExpression(params.cronExpr);
    if (validationError) {
      throw new Error(`Invalid cron expression: ${validationError}`);
    }

    const next = computeNextRun(params.cronExpr);
    const schedule: Schedule = {
      id: randomUUID(),
      cronExpr: params.cronExpr,
      agentName: params.agentName,
      prompt: params.prompt,
      paused: false,
      budgetUsd: params.budgetUsd,
      allowedTools: params.allowedTools,
      orgId: params.orgId,
      createdAt: Date.now(),
      nextRunAt: next?.getTime(),
      runCount: 0,
    };
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  get(id: string): Schedule | null {
    return this.schedules.get(id) ?? null;
  }

  list(orgId?: string): Schedule[] {
    const all = Array.from(this.schedules.values());
    if (orgId !== undefined) {
      return all.filter(s => s.orgId === orgId);
    }
    return all;
  }

  delete(id: string): void {
    this.schedules.delete(id);
  }

  setPaused(id: string, paused: boolean): void {
    const s = this.schedules.get(id);
    if (s) {
      s.paused = paused;
    }
  }

  recordRun(id: string, nextRunAt?: number): void {
    const s = this.schedules.get(id);
    if (s) {
      s.lastRunAt = Date.now();
      s.runCount++;
      s.nextRunAt = nextRunAt;
    }
  }

  updateNextRunAt(id: string, nextRunAt: number): void {
    const s = this.schedules.get(id);
    if (s) {
      s.nextRunAt = nextRunAt;
    }
  }
}

const TICK_INTERVAL_MS = 15_000;

export class Scheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: ScheduleStore,
    private readonly dispatchFn: DispatchFn,
  ) {}

  start(): void {
    // Recompute nextRunAt for all schedules on startup (restart recovery)
    for (const schedule of this.store.list()) {
      const next = computeNextRun(schedule.cronExpr);
      if (next) {
        this.store.updateNextRunAt(schedule.id, next.getTime());
      }
    }

    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Exposed for testing. */
  tick(): void {
    const now = Date.now();
    for (const schedule of this.store.list()) {
      if (schedule.paused) continue;
      if (schedule.nextRunAt === undefined || schedule.nextRunAt > now) continue;

      try {
        this.dispatchFn(schedule.agentName, schedule.prompt, {
          budgetUsd: schedule.budgetUsd,
          allowedTools: schedule.allowedTools,
          orgId: schedule.orgId,
        });
      } catch {
        // Dispatch failures should not stop other schedules from running
      }

      // Compute next occurrence after this run
      const next = computeNextRun(schedule.cronExpr);
      this.store.recordRun(schedule.id, next?.getTime());
    }
  }
}
