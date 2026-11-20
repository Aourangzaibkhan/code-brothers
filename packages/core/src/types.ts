/** Workflow graph + execution record types for the Code Brothers engine. */

/** One node placed on a workflow canvas. */
export interface WorkflowNodeInstance {
  /** Unique id within the workflow (edges and `$node` lookups key off name/id). */
  id: string;
  /** Node type id resolved through the NodeRegistry, e.g. `core.if`. */
  type: string;
  /** Human name used by `$node["Name"]` expressions. Defaults to `id`. */
  name?: string;
  parameters?: Record<string, unknown>;
  disabled?: boolean;
  /** What to do when this node throws. Default: inherit workflow settings, else `stop`. */
  onError?: 'stop' | 'continue';
  /** Retry policy for this node (exponential backoff between attempts). */
  retry?: {
    /** Total attempts including the first. Default 1 (no retry). */
    maxAttempts: number;
    /** Base delay in ms before the first retry. Default 1000. */
    backoffMs?: number;
    /** Delay multiplier per attempt. Default 2. */
    backoffMultiplier?: number;
  };
}

/** A connection from one node's output branch to another node's input. */
export interface WorkflowEdge {
  from: string;
  /** Output branch index of the source node. Default 0. */
  output?: number;
  to: string;
  /** Input index of the target node. Only input 0 is routed today; kept for graph compatibility. */
  input?: number;
}

export interface WorkflowSettings {
  timezone?: string;
  /** Default error behaviour for nodes without their own `onError`. */
  onError?: 'stop' | 'continue';
  /** Workflow-level variables, exposed to nodes as ctx.variables / `$vars`. */
  variables?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  name?: string;
  nodes: WorkflowNodeInstance[];
  edges: WorkflowEdge[];
  settings?: WorkflowSettings;
}

export type ExecutionStepStatus = 'success' | 'error' | 'skipped';

export interface ExecutionStep {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: ExecutionStepStatus;
  startedAt: string;
  durationMs: number;
  /** How many times the node was attempted (1 = no retries happened). */
  attempts: number;
  /** Redacted deep copy of the items the node received. */
  input: unknown;
  /** Redacted deep copy of the branches the node returned. */
  output: unknown;
  error?: string;
}

export type ExecutionStatus = 'success' | 'error' | 'partial';

export interface ExecutionRecord {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: ExecutionStep[];
  error?: string;
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}
