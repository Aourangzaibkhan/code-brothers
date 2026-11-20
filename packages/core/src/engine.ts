import { randomUUID } from 'node:crypto';
import {
  ConsoleNodeLogger,
  createRedactingLogger,
  type NodeContext,
  type NodeItem,
  type NodeLogger,
  type NodeOutputData,
  NodeRegistry,
} from '@code-brothers/node-sdk';
import {
  evaluateExpression,
  renderTemplate,
  type ExpressionData,
} from './expression.js';
import { defaultSsrfGuard, type SsrfGuard } from './ssrf.js';
import {
  WorkflowError,
  type ExecutionRecord,
  type ExecutionStep,
  type WorkflowDefinition,
  type WorkflowNodeInstance,
} from './types.js';

export interface EngineOptions {
  /** Applied to every input/output copy stored in the execution record. */
  redactor?: (value: unknown) => unknown;
  /** Base logger for node contexts (wrapped with the redactor). */
  logger?: NodeLogger;
  /** Vault lookup used by ctx.getCredentials. */
  credentialsProvider?: (
    name: string,
    nodeType: string,
  ) => Promise<Record<string, unknown> | undefined>;
  /** Guard run before every ctx.fetch request. Default: deny private IPs. */
  ssrfGuard?: SsrfGuard;
  /** Fetch implementation behind the guard. Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (retry backoff + wait node). */
  sleep?: (ms: number) => Promise<void>;
  /** Sandbox timeout for expressions. Default 2000ms. */
  expressionTimeoutMs?: number;
}

export interface ExecuteOptions {
  /** Which trigger node to start from. Default: first trigger node. */
  triggerNodeId?: string;
  /**
   * Data fed into the trigger node: a plain object becomes one item
   * (`[{ json: data }]`), an array of items is used as-is.
   */
  triggerData?: unknown;
  /** Extra workflow variables (merged over workflow settings variables). */
  variables?: Record<string, unknown>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function cloneForRecord(
  value: unknown,
  redactor: (value: unknown) => unknown,
): unknown {
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    copy = String(value);
  }
  return redactor(copy);
}

function normalizeTriggerData(data: unknown): NodeItem[] {
  if (data === undefined || data === null) return [];
  if (Array.isArray(data)) {
    return data.map((entry) =>
      entry && typeof entry === 'object' && 'json' in entry
        ? (entry as NodeItem)
        : { json: (entry ?? {}) as Record<string, unknown> },
    );
  }
  if (typeof data === 'object') {
    return [{ json: data as Record<string, unknown> }];
  }
  return [{ json: { value: data } }];
}

/**
 * The DAG execution engine.
 *
 * Execution model: nodes run in topological order starting from the chosen
 * trigger. Each node receives the concatenation of items delivered over its
 * incoming edges; a node's output branches are routed along edges by branch
 * index. A node that receives no items (e.g. downstream of an untaken IF
 * branch) is recorded as `skipped` and produces nothing.
 */
export class WorkflowEngine {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly guard: SsrfGuard;
  private readonly fetchImpl: typeof fetch;
  private readonly redactor: (value: unknown) => unknown;
  private readonly baseLogger: NodeLogger;

  constructor(
    private readonly registry: NodeRegistry,
    private readonly options: EngineOptions = {},
  ) {
    this.sleep = options.sleep ?? realSleep;
    this.guard = options.ssrfGuard ?? defaultSsrfGuard;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.redactor = options.redactor ?? ((value: unknown) => value);
    this.baseLogger = options.logger ?? new ConsoleNodeLogger();
  }

  async execute(
    workflow: WorkflowDefinition,
    runOptions: ExecuteOptions = {},
  ): Promise<ExecutionRecord> {
    const startedAt = new Date();
    const executionId = randomUUID();
    this.validate(workflow);

    const order = this.topologicalOrder(workflow);
    const startNode = this.pickStartNode(workflow, runOptions.triggerNodeId);
    const variables: Record<string, unknown> = {
      ...(workflow.settings?.variables ?? {}),
      ...(runOptions.variables ?? {}),
    };

    const deliveries = new Map<string, NodeItem[]>();
    const nodeResults = new Map<string, NodeOutputData>();
    const nodeDataByName: ExpressionData['$node'] = {};
    const steps: ExecutionStep[] = [];
    const processed = new Set<string>();
    let halted = false;
    let sawContinuedError = false;
    let fatalError: string | undefined;

    const logger = createRedactingLogger(this.baseLogger, this.redactor);
    const guardedFetch = async (
      url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const target = new URL(String(url));
      await this.guard(target);
      return this.fetchImpl(target, init);
    };

    for (const node of order) {
      if (halted) break;
      processed.add(node.id);
      const nodeName = node.name ?? node.id;
      const isStart = node.id === startNode.id;
      const inputItems: NodeItem[] = isStart
        ? normalizeTriggerData(runOptions.triggerData)
        : (deliveries.get(node.id) ?? []);

      if (!isStart && inputItems.length === 0) {
        steps.push(this.skippedStep(node, nodeName));
        continue;
      }

      if (node.disabled) {
        const outputs: NodeOutputData = [inputItems];
        nodeResults.set(node.id, outputs);
        nodeDataByName[nodeName] = { json: inputItems[0]?.json ?? {} };
        this.route(workflow, node.id, outputs, deliveries);
        steps.push({
          ...this.skippedStep(node, nodeName),
          input: cloneForRecord(inputItems, this.redactor),
          output: cloneForRecord(outputs, this.redactor),
        });
        continue;
      }

      const definition = this.registry.getOrThrow(node.type);
      const stepStarted = Date.now();
      const stepStartedAt = new Date().toISOString();
      const maxAttempts = Math.max(1, node.retry?.maxAttempts ?? 1);
      const backoffMs = node.retry?.backoffMs ?? 1000;
      const backoffMultiplier = node.retry?.backoffMultiplier ?? 2;

      const ctx = this.buildContext({
        executionId,
        workflow,
        node,
        variables,
        inputItems,
        nodeDataByName,
        logger,
        fetch: guardedFetch,
      });

      let attempts = 0;
      let outputs: NodeOutputData | undefined;
      let nodeError: Error | undefined;
      while (attempts < maxAttempts) {
        attempts += 1;
        try {
          outputs = await definition.execute(ctx, inputItems);
          nodeError = undefined;
          break;
        } catch (err) {
          nodeError = err instanceof Error ? err : new Error(String(err));
          if (attempts < maxAttempts) {
            await this.sleep(
              backoffMs * Math.pow(backoffMultiplier, attempts - 1),
            );
          }
        }
      }

      const durationMs = Date.now() - stepStarted;

      if (nodeError || !outputs) {
        const message = nodeError?.message ?? 'Node produced no output';
        steps.push({
          nodeId: node.id,
          nodeName,
          nodeType: node.type,
          status: 'error',
          startedAt: stepStartedAt,
          durationMs,
          attempts,
          input: cloneForRecord(inputItems, this.redactor),
          output: null,
          error: message,
        });
        const onError =
          node.onError ?? workflow.settings?.onError ?? 'stop';
        if (onError === 'continue') {
          sawContinuedError = true;
          nodeResults.set(node.id, []);
          continue;
        }
        halted = true;
        fatalError = `Node "${nodeName}" (${node.type}) failed: ${message}`;
        break;
      }

      nodeResults.set(node.id, outputs);
      nodeDataByName[nodeName] = { json: outputs[0]?.[0]?.json ?? {} };
      this.route(workflow, node.id, outputs, deliveries);
      steps.push({
        nodeId: node.id,
        nodeName,
        nodeType: node.type,
        status: 'success',
        startedAt: stepStartedAt,
        durationMs,
        attempts,
        input: cloneForRecord(inputItems, this.redactor),
        output: cloneForRecord(outputs, this.redactor),
      });
    }

    // Any node never reached (halted run or disconnected) is recorded skipped.
    for (const node of order) {
      if (!processed.has(node.id)) {
        steps.push(this.skippedStep(node, node.name ?? node.id));
      }
    }

    const finishedAt = new Date();
    return {
      id: executionId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: fatalError ? 'error' : sawContinuedError ? 'partial' : 'success',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      steps,
      ...(fatalError ? { error: fatalError } : {}),
    };
  }

  private skippedStep(
    node: WorkflowNodeInstance,
    nodeName: string,
  ): ExecutionStep {
    return {
      nodeId: node.id,
      nodeName,
      nodeType: node.type,
      status: 'skipped',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      attempts: 0,
      input: null,
      output: null,
    };
  }

  private route(
    workflow: WorkflowDefinition,
    fromId: string,
    outputs: NodeOutputData,
    deliveries: Map<string, NodeItem[]>,
  ): void {
    for (const edge of workflow.edges) {
      if (edge.from !== fromId) continue;
      const branch = outputs[edge.output ?? 0] ?? [];
      if (branch.length === 0) continue;
      const existing = deliveries.get(edge.to) ?? [];
      existing.push(...branch);
      deliveries.set(edge.to, existing);
    }
  }

  private buildContext(args: {
    executionId: string;
    workflow: WorkflowDefinition;
    node: WorkflowNodeInstance;
    variables: Record<string, unknown>;
    inputItems: NodeItem[];
    nodeDataByName: ExpressionData['$node'];
    logger: NodeLogger;
    fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  }): NodeContext {
    const { workflow, node, variables, inputItems, nodeDataByName } = args;
    const timeoutMs = this.options.expressionTimeoutMs;
    const expressionData = (
      itemJson?: Record<string, unknown>,
    ): ExpressionData => ({
      $json: itemJson ?? inputItems[0]?.json ?? {},
      $items: inputItems,
      $node: nodeDataByName,
      $vars: variables,
      $workflow: { id: workflow.id, name: workflow.name },
      $execution: { id: args.executionId },
    });

    return {
      executionId: args.executionId,
      workflowId: workflow.id,
      nodeId: node.id,
      nodeType: node.type,
      parameters: node.parameters ?? {},
      logger: args.logger,
      variables,
      getCredentials: (name: string) =>
        this.options.credentialsProvider
          ? this.options.credentialsProvider(name, node.type)
          : Promise.resolve(undefined),
      fetch: args.fetch,
      evaluateExpression: (source, itemJson) =>
        evaluateExpression(source, expressionData(itemJson), {
          timeoutMs,
        }),
      renderTemplate: (template, itemJson) =>
        renderTemplate(template, expressionData(itemJson), {
          timeoutMs,
        }),
      sleep: this.sleep,
    };
  }

  private validate(workflow: WorkflowDefinition): void {
    if (!workflow || !Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
      throw new WorkflowError('Workflow has no nodes');
    }
    const ids = new Set<string>();
    for (const node of workflow.nodes) {
      if (ids.has(node.id)) {
        throw new WorkflowError(`Duplicate node id "${node.id}" in workflow`);
      }
      ids.add(node.id);
      if (!this.registry.has(node.type)) {
        throw new WorkflowError(
          `Workflow references unknown node type "${node.type}" (node "${node.id}")`,
        );
      }
    }
    for (const edge of workflow.edges ?? []) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        throw new WorkflowError(
          `Workflow edge references unknown node: ${edge.from} -> ${edge.to}`,
        );
      }
    }
  }

  private pickStartNode(
    workflow: WorkflowDefinition,
    triggerNodeId?: string,
  ): WorkflowNodeInstance {
    if (triggerNodeId) {
      const node = workflow.nodes.find((n) => n.id === triggerNodeId);
      if (!node) {
        throw new WorkflowError(`Trigger node "${triggerNodeId}" not found`);
      }
      return node;
    }
    const trigger = workflow.nodes.find(
      (n) => this.registry.get(n.type)?.trigger,
    );
    if (trigger) return trigger;
    const targeted = new Set((workflow.edges ?? []).map((e) => e.to));
    const root = workflow.nodes.find((n) => !targeted.has(n.id));
    if (!root) throw new WorkflowError('Workflow has no start node');
    return root;
  }

  private topologicalOrder(
    workflow: WorkflowDefinition,
  ): WorkflowNodeInstance[] {
    const indegree = new Map<string, number>();
    const byId = new Map<string, WorkflowNodeInstance>();
    for (const node of workflow.nodes) {
      indegree.set(node.id, 0);
      byId.set(node.id, node);
    }
    for (const edge of workflow.edges ?? []) {
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
    const queue = workflow.nodes
      .filter((n) => indegree.get(n.id) === 0)
      .map((n) => n.id);
    const order: WorkflowNodeInstance[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(byId.get(id)!);
      for (const edge of workflow.edges ?? []) {
        if (edge.from !== id) continue;
        const next = (indegree.get(edge.to) ?? 0) - 1;
        indegree.set(edge.to, next);
        if (next === 0) queue.push(edge.to);
      }
    }
    if (order.length !== workflow.nodes.length) {
      throw new WorkflowError('Workflow graph contains a cycle');
    }
    return order;
  }
}
