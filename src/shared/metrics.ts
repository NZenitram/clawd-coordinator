import { Counter, Histogram, Gauge, Registry } from 'prom-client';

export class MetricsCollector {
  readonly registry: Registry;
  readonly tasksDispatched: Counter;
  readonly tasksCompleted: Counter;
  readonly tasksErrored: Counter;
  readonly taskDuration: Histogram;
  readonly connectedAgents: Gauge;
  readonly queueDepth: Gauge;
  readonly activeTasks: Gauge;

  /** Track start times for duration measurement: taskId → start epoch ms */
  private taskStartTimes = new Map<string, number>();

  constructor() {
    this.registry = new Registry();

    this.tasksDispatched = new Counter({
      name: 'coord_tasks_dispatched_total',
      help: 'Total number of tasks dispatched to agents',
      registers: [this.registry],
    });

    this.tasksCompleted = new Counter({
      name: 'coord_tasks_completed_total',
      help: 'Total number of tasks that completed successfully',
      registers: [this.registry],
    });

    this.tasksErrored = new Counter({
      name: 'coord_tasks_errored_total',
      help: 'Total number of tasks that ended in error',
      registers: [this.registry],
    });

    this.taskDuration = new Histogram({
      name: 'coord_task_duration_seconds',
      help: 'Duration of tasks from dispatch to completion or error',
      buckets: [1, 5, 15, 30, 60, 120, 300, 600],
      registers: [this.registry],
    });

    this.connectedAgents = new Gauge({
      name: 'coord_connected_agents',
      help: 'Number of currently connected agents',
      registers: [this.registry],
    });

    this.queueDepth = new Gauge({
      name: 'coord_queue_depth',
      help: 'Current number of tasks waiting in the queue',
      registers: [this.registry],
    });

    this.activeTasks = new Gauge({
      name: 'coord_active_tasks',
      help: 'Current number of tasks actively running on agents',
      registers: [this.registry],
    });
  }

  /** Record the start time of a task for duration tracking. */
  recordTaskStart(taskId: string): void {
    this.taskStartTimes.set(taskId, Date.now());
  }

  /** Observe task duration in seconds and clean up the start time record. */
  observeTaskDuration(taskId: string): void {
    const start = this.taskStartTimes.get(taskId);
    if (start !== undefined) {
      this.taskDuration.observe((Date.now() - start) / 1000);
      this.taskStartTimes.delete(taskId);
    }
  }

  /** Return JSON-friendly stats for the /api/stats endpoint. */
  getStats(): Record<string, number> {
    // prom-client counters/gauges expose their value via .get() which is async;
    // we track a parallel in-memory snapshot for the synchronous JSON endpoint.
    return {
      tasksDispatched: this._dispatched,
      tasksCompleted: this._completed,
      tasksErrored: this._errored,
      connectedAgents: this._connectedAgents,
      queueDepth: this._queueDepth,
      activeTasks: this._activeTasks,
    };
  }

  // --- Synchronous shadow counters used by getStats() ---
  private _dispatched = 0;
  private _completed = 0;
  private _errored = 0;
  private _connectedAgents = 0;
  private _queueDepth = 0;
  private _activeTasks = 0;

  incDispatched(): void {
    this._dispatched++;
    this.tasksDispatched.inc();
  }

  incCompleted(): void {
    this._completed++;
    this.tasksCompleted.inc();
  }

  incErrored(): void {
    this._errored++;
    this.tasksErrored.inc();
  }

  incConnectedAgents(): void {
    this._connectedAgents++;
    this.connectedAgents.inc();
  }

  decConnectedAgents(): void {
    if (this._connectedAgents > 0) this._connectedAgents--;
    this.connectedAgents.dec();
  }

  setQueueDepth(depth: number): void {
    this._queueDepth = depth;
    this.queueDepth.set(depth);
  }

  setActiveTasks(count: number): void {
    this._activeTasks = count;
    this.activeTasks.set(count);
  }
}

export const metrics = new MetricsCollector();
