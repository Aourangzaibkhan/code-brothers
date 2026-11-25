/**
 * Shared contracts for the worker app: the workflow-run job payload, the
 * workflow provider the worker loads definitions through, and the
 * execution sink it records results into. Both sit behind interfaces so
 * the API's stores (or a database) can be plugged in without changes.
 */
import type { ExecutionRecord, WorkflowDefinition } from '@code-brothers/core';

export type TriggerType = 'manual' | 'webhook' | 'cron' | 'polling' | 'retry';

/** Payload of a `workflow.run` queue job. */
export interface WorkflowRunJobData {
  workflowId: string;
  triggerType?: TriggerType;
  triggerData?: unknown;
  variables?: Record<string, unknown>;
  triggerNodeId?: string;
}

/** An engine ExecutionRecord plus the platform trigger bookkeeping. */
export interface StoredExecution extends ExecutionRecord {
  triggerType: TriggerType;
  /** Workflow version the run executed against (recorded in the DB). */
  workflowVersion?: number;
}

/** A workflow definition plus the ownership the worker needs to run it:
 * the owning merchant's id (for the vault-backed credentials provider and
 * for the `$vars.userId` every run gets, exactly like the API) and the
 * version the execution is recorded against. */
export interface LoadedWorkflow {
  definition: WorkflowDefinition;
  userId: string;
  currentVersion: number;
}

/** Where the worker loads workflow definitions from. */
export interface WorkflowProvider {
  getWorkflow(id: string): Promise<LoadedWorkflow | undefined>;
  /** Every active workflow, for the scheduler to arm at boot. */
  listActive(): Promise<LoadedWorkflow[]>;
}

/** Map-backed WorkflowProvider (local runs + tests). */
export class MapWorkflowProvider implements WorkflowProvider {
  private readonly map = new Map<string, LoadedWorkflow>();

  constructor(workflows: Iterable<WorkflowDefinition> = [], userId = 'local') {
    for (const workflow of workflows) {
      this.map.set(workflow.id, { definition: workflow, userId, currentVersion: 1 });
    }
  }

  set(workflow: WorkflowDefinition, userId = 'local', currentVersion = 1): void {
    this.map.set(workflow.id, { definition: workflow, userId, currentVersion });
  }

  async getWorkflow(id: string): Promise<LoadedWorkflow | undefined> {
    return this.map.get(id);
  }

  async listActive(): Promise<LoadedWorkflow[]> {
    return [...this.map.values()];
  }
}

/** Where the worker records finished executions. */
export interface ExecutionSink {
  record(execution: StoredExecution): Promise<void>;
}

/** In-memory ExecutionSink (local runs + tests). */
export class InMemoryExecutionSink implements ExecutionSink {
  private readonly executions: StoredExecution[] = [];

  async record(execution: StoredExecution): Promise<void> {
    this.executions.push(execution);
  }

  all(): StoredExecution[] {
    return [...this.executions];
  }

  byWorkflow(workflowId: string): StoredExecution[] {
    return this.executions.filter((e) => e.workflowId === workflowId);
  }

  get size(): number {
    return this.executions.length;
  }
}
