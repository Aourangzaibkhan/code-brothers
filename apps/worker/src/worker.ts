/**
 * WorkflowWorker — consumes `workflow.run` jobs from a JobQueue
 * (@code-brothers/core abstraction; InMemoryQueue today, BullMQ behind
 * the same interface later), executes them through the workflow engine,
 * and records every finished execution into the sink.
 */
import {
  InMemoryQueue,
  createSsrfGuard,
  WorkflowEngine,
  type DeadLetter,
  type EnqueueOptions,
  type EngineOptions,
  type JobQueue,
  type QueueJob,
  type WorkflowEngine as WorkflowEngineType,
} from '@code-brothers/core';
import { createPlatformRegistry } from '@code-brothers/connector-registry';
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
  engine?: WorkflowEngineType;
  /** Engine options used when no engine is supplied. */
  engineOptions?: EngineOptions;
  /**
   * Vault lookup per workflow owner. When set, the worker builds a fresh
   * engine per run with that owner's provider (exactly like the API's
   * executeWorkflow) instead of sharing one engine — credentials are
   * never resolved for the wrong merchant. When unset, the shared engine
   * from `engine`/`engineOptions` runs every job.
   */
  credentialsProviderFor?: (
    userId: string,
  ) => NonNullable<EngineOptions['credentialsProvider']>;
  /** Internal hosts the SSRF guard allows (default: platform services). */
  internalHosts?: string[];
  /** Kill-switch probe: when it returns true, run jobs are refused. */
  isHalted?: () => boolean | Promise<boolean>;
  /** Injectable sleep for the default in-memory queue (tests). */
  queueSleep?: (ms: number) => Promise<void>;
}

export class WorkflowWorker {
  readonly queue: JobQueue<WorkflowRunJobData>;
  readonly executions: ExecutionSink;
  private readonly workflows: WorkflowProvider;
  private readonly engine: WorkflowEngineType;
  private readonly engineOptions: EngineOptions;
  private readonly internalHosts: string[];
  private readonly credentialsProviderFor?: WorkerOptions['credentialsProviderFor'];
  private readonly isHalted?: () => boolean | Promise<boolean>;

  constructor(options: WorkerOptions) {
    this.workflows = options.workflows;
    this.executions = options.executions ?? new InMemoryExecutionSink();
    this.queue =
      options.queue ?? new InMemoryQueue<WorkflowRunJobData>({ sleep: options.queueSleep });
    // Same platform registry as the API: every shipped node type resolves,
    // and the same internal-hosts SSRF allowlist applies.
    this.internalHosts =
      options.internalHosts ??
      (process.env.CB_INTERNAL_HOSTS
        ? process.env.CB_INTERNAL_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
        : ['localhost', 'ai-media-worker', 'host.docker.internal']);
    this.engineOptions = options.engineOptions ?? {};
    this.engine =
      options.engine ??
      new WorkflowEngine(createPlatformRegistry(), {
        redactor: (value) => redact(value),
        ssrfGuard: createSsrfGuard({ allowedHosts: this.internalHosts }),
        ...this.engineOptions,
      });
    this.credentialsProviderFor = options.credentialsProviderFor;
    this.isHalted = options.isHalted;
  }

  /**
   * The engine for one run. With a per-owner credentials provider, a fresh
   * engine is built (mirroring the API) so the vault lookup is scoped to
   * that run's merchant; otherwise the shared engine is reused.
   */
  private engineFor(userId: string): WorkflowEngineType {
    if (!this.credentialsProviderFor) return this.engine;
    return new WorkflowEngine(createPlatformRegistry(), {
      redactor: (value) => redact(value),
      ssrfGuard: createSsrfGuard({ allowedHosts: this.internalHosts }),
      ...this.engineOptions,
      credentialsProvider: this.credentialsProviderFor(userId),
    });
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
    if (this.isHalted && (await this.isHalted())) {
      throw new Error('Platform halted by kill switch — workflow runs are frozen');
    }
    const loaded = await this.workflows.getWorkflow(job.data.workflowId);
    if (!loaded) {
      throw new Error(`Workflow not found: ${job.data.workflowId}`);
    }
    const record = await this.engineFor(loaded.userId).execute(loaded.definition, {
      triggerData: job.data.triggerData,
      // The owning merchant's id is always available to templates as
      // $vars.userId (same as the API's executeWorkflow).
      variables: { userId: loaded.userId, ...(job.data.variables ?? {}) },
      triggerNodeId: job.data.triggerNodeId,
    });
    await this.executions.record({
      ...record,
      triggerType: job.data.triggerType ?? 'manual',
      workflowVersion: loaded.currentVersion,
    });
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
