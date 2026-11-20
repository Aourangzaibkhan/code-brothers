/**
 * WorkflowWorker — consumes `workflow.run` jobs from a JobQueue
 * (@code-brothers/core abstraction; InMemoryQueue today, BullMQ behind
 * the same interface later), executes them through the workflow engine,
 * and records every finished execution into the sink.
 */
import {
  InMemoryQueue,
  createEngine,
  type DeadLetter,
  type EnqueueOptions,
  type EngineOptions,
  type JobQueue,
  type QueueJob,
  type WorkflowEngine,
} from '@code-brothers/core';
import { redact } from '@code-brothers/security';
import {
  InMemoryExecutionSink,
  type ExecutionSink,
  type WorkflowProvider,
  type WorkflowRunJobData,
} from './types.js';

export const WORKFLOW_RUN_JOB = 'workflow.run';

export interface WorkerOptions {
  /** Where workflow definitions are loaded from. */
  workflows: WorkflowProvider;
  /** Where finished executions are recorded. Default: in-memory sink. */
  executions?: ExecutionSink;
  /** Job queue backend. Default: InMemoryQueue. */
  queue?: JobQueue<WorkflowRunJobData>;
  /** Pre-built engine (overrides engineOptions). */
  engine?: WorkflowEngine;
  /** Engine options used when no engine is supplied. */
  engineOptions?: EngineOptions;
  /** Kill-switch probe: when it returns true, run jobs are refused. */
  isHalted?: () => boolean;
  /** Injectable sleep for the default in-memory queue (tests). */
  queueSleep?: (ms: number) => Promise<void>;
}

export class WorkflowWorker {
  readonly queue: JobQueue<WorkflowRunJobData>;
  readonly executions: ExecutionSink;
  private readonly workflows: WorkflowProvider;
  private readonly engine: WorkflowEngine;
  private readonly isHalted?: () => boolean;

  constructor(options: WorkerOptions) {
    this.workflows = options.workflows;
    this.executions = options.executions ?? new InMemoryExecutionSink();
    this.queue =
      options.queue ?? new InMemoryQueue<WorkflowRunJobData>({ sleep: options.queueSleep });
    this.engine =
      options.engine ??
      createEngine({ redactor: (value) => redact(value), ...options.engineOptions });
    this.isHalted = options.isHalted;
  }

  /** Register the job handler and start processing. */
  start(): void {
    this.queue.process(this.handle);
  }

  /** Enqueue a workflow run for background processing. */
  async enqueueRun(
    data: WorkflowRunJobData,
    options?: EnqueueOptions,
  ): Promise<QueueJob<WorkflowRunJobData>> {
    return this.queue.enqueue(WORKFLOW_RUN_JOB, data, options);
  }

  /** Resolves when the queue is empty and no job is active. */
  async waitForIdle(): Promise<void> {
    return this.queue.waitForIdle();
  }

  deadLetters(): DeadLetter<WorkflowRunJobData>[] {
    return this.queue.deadLetters();
  }

  private readonly handle = async (job: QueueJob<WorkflowRunJobData>): Promise<void> => {
    if (job.name !== WORKFLOW_RUN_JOB) return; // foreign job — not ours
    if (this.isHalted?.()) {
      throw new Error('Platform halted by kill switch — workflow runs are frozen');
    }
    const workflow = await this.workflows.getWorkflow(job.data.workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${job.data.workflowId}`);
    }
    const record = await this.engine.execute(workflow, {
      triggerData: job.data.triggerData,
      variables: job.data.variables,
      triggerNodeId: job.data.triggerNodeId,
    });
    await this.executions.record({ ...record, triggerType: job.data.triggerType ?? 'manual' });
  };
}

export interface StartedWorker {
  worker: WorkflowWorker;
  queue: JobQueue<WorkflowRunJobData>;
  executions: ExecutionSink;
}

/** Convenience: build a WorkflowWorker and start it in one call. */
export function startWorker(options: WorkerOptions): StartedWorker {
  const worker = new WorkflowWorker(options);
  worker.start();
  return { worker, queue: worker.queue, executions: worker.executions };
}
