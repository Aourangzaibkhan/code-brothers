/**
 * Scheduler — arms the `core.cronTrigger` nodes of registered workflows
 * and fires them when their slot comes due. Next runs are computed with
 * @code-brothers/core's nextCronRun (the same parser the trigger node
 * itself validates with).
 *
 * Exactly-once per slot: an entry's next run is advanced BEFORE the fire
 * handler is invoked, so repeated ticks at the same instant can never
 * fire the same slot twice.
 */
import {
  nextCronRun,
  type WorkflowDefinition,
  type WorkflowNodeInstance,
} from '@code-brothers/core';

export interface ScheduleFireEvent {
  workflow: WorkflowDefinition;
  node: WorkflowNodeInstance;
  expression: string;
  /** The slot this firing belongs to (the entry's previous nextRun). */
  scheduledFor: Date;
}

export type ScheduleFireHandler = (event: ScheduleFireEvent) => Promise<void> | void;

export interface SchedulerOptions {
  onFire: ScheduleFireHandler;
  /** Injectable clock (tests). Default: real time. */
  now?: () => Date;
}

interface ScheduleEntry {
  workflow: WorkflowDefinition;
  node: WorkflowNodeInstance;
  expression: string;
  nextRun: Date;
}

export class Scheduler {
  private readonly entries = new Map<string, ScheduleEntry>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: SchedulerOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Arm every enabled cronTrigger node of a workflow. Returns how many
   * schedules were armed. Nodes without a valid `expression` parameter
   * are skipped (nextCronRun validates the rest and throws on bad input).
   */
  register(workflow: WorkflowDefinition, from: Date = this.now()): number {
    let armed = 0;
    for (const node of workflow.nodes) {
      if (node.type !== 'core.cronTrigger' || node.disabled) continue;
      const expression = node.parameters?.expression;
      if (typeof expression !== 'string' || expression.trim() === '') continue;
      this.entries.set(`${workflow.id}:${node.id}`, {
        workflow,
        node,
        expression,
        nextRun: nextCronRun(expression, from),
      });
      armed++;
    }
    return armed;
  }

  /**
   * Arm only the cronTrigger nodes of a workflow that are NOT already
   * armed. Unlike register(), already-armed entries keep their nextRun —
   * the worker's periodic refresh uses this so re-scanning never delays
   * a schedule that is already waiting for its slot.
   */
  registerIfMissing(workflow: WorkflowDefinition, from: Date = this.now()): number {
    let armed = 0;
    for (const node of workflow.nodes) {
      if (node.type !== 'core.cronTrigger' || node.disabled) continue;
      const key = `${workflow.id}:${node.id}`;
      if (this.entries.has(key)) continue;
      const expression = node.parameters?.expression;
      if (typeof expression !== 'string' || expression.trim() === '') continue;
      this.entries.set(key, {
        workflow,
        node,
        expression,
        nextRun: nextCronRun(expression, from),
      });
      armed++;
    }
    return armed;
  }

  /** Disarm all schedules of a workflow. Returns how many were removed. */
  unregister(workflowId: string): number {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${workflowId}:`)) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  list(): Array<{ workflowId: string; nodeId: string; expression: string; nextRun: Date }> {
    return [...this.entries.values()].map((entry) => ({
      workflowId: entry.workflow.id,
      nodeId: entry.node.id,
      expression: entry.expression,
      nextRun: entry.nextRun,
    }));
  }

  /**
   * Fire every entry whose slot is due at `at` (default: now). Returns
   * the number of firings. Each due slot fires exactly once.
   */
  async tick(at: Date = this.now()): Promise<number> {
    let fired = 0;
    for (const entry of this.entries.values()) {
      let guard = 0;
      while (entry.nextRun.getTime() <= at.getTime() && guard++ < 1000) {
        const scheduledFor = entry.nextRun;
        entry.nextRun = nextCronRun(entry.expression, scheduledFor);
        await this.options.onFire({
          workflow: entry.workflow,
          node: entry.node,
          expression: entry.expression,
          scheduledFor,
        });
        fired++;
      }
    }
    return fired;
  }

  /** Start ticking on an interval (unref'd — never keeps a process alive). */
  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
