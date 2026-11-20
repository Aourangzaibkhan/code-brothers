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
}

/** Where the worker loads workflow definitions from. */
export interface WorkflowProvider {
  getWorkflow(id: string): Promise<WorkflowDefinition | undefined>;
}

/** Map-backed WorkflowProvider (local runs + tests). */
export class MapWorkflowProvider implements WorkflowProvider {
  private readonly map = new Map<string, WorkflowDefinition>();

  constructor(workflows: Iterable<WorkflowDefinition> = []) {
    for (const workflow of workflows) this.map.set(workflow.id, workflow);
  }

  set(workflow: WorkflowDefinition): void {
    this.map.set(workflow.id, workflow);
  }

  async getWorkflow(id: string): Promise<WorkflowDefinition | undefined> {
    return this.map.get(id);
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
