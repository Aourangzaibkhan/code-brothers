import { evaluateExpression, renderTemplate } from './expression.js';
import { MemoryNodeLogger } from './logger.js';
import type { NodeContext } from './types.js';

export interface TestNodeContextOptions {
  executionId?: string;
  workflowId?: string;
  nodeId?: string;
  nodeType?: string;
  parameters?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  /** Credential slot name -> credential object. */
  credentials?: Record<string, Record<string, unknown>>;
  fetchImpl?: typeof fetch;
  evaluateExpression?: NodeContext['evaluateExpression'];
  renderTemplate?: NodeContext['renderTemplate'];
  sleep?: (ms: number) => Promise<void>;
}

export interface TestNodeContext {
  ctx: NodeContext;
  logger: MemoryNodeLogger;
  /** Durations passed to ctx.sleep, in call order. */
  sleeps: number[];
}

/**
 * Build a NodeContext for unit-testing nodes without the engine. Expression
 * evaluation lives in this package (./expression.js), so the test context
 * renders templates for real — a node under test behaves exactly as it
 * does under the engine. Callers may still inject their own
 * evaluateExpression/renderTemplate implementations.
 */
export function createTestNodeContext(
  options: TestNodeContextOptions = {},
): TestNodeContext {
  const logger = new MemoryNodeLogger();
  const sleeps: number[] = [];
  const credentials = options.credentials ?? {};

  const ctx: NodeContext = {
    executionId: options.executionId ?? 'test-execution',
    workflowId: options.workflowId ?? 'test-workflow',
    nodeId: options.nodeId ?? 'test-node',
    nodeType: options.nodeType ?? 'test.node',
    parameters: options.parameters ?? {},
    logger,
    variables: options.variables ?? {},
    async getCredentials(name: string) {
      return credentials[name];
    },
    fetch: options.fetchImpl ?? globalThis.fetch,
    evaluateExpression:
      options.evaluateExpression ??
      ((source, itemJson) =>
        evaluateExpression(source, {
          $json: itemJson ?? {},
          $vars: options.variables ?? {},
          $workflow: { id: options.workflowId ?? 'test-workflow' },
          $execution: { id: options.executionId ?? 'test-execution' },
        })),
    renderTemplate:
      options.renderTemplate ??
      ((template, itemJson) =>
        renderTemplate(template, {
          $json: itemJson ?? {},
          $vars: options.variables ?? {},
          $workflow: { id: options.workflowId ?? 'test-workflow' },
          $execution: { id: options.executionId ?? 'test-execution' },
        })),
    sleep:
      options.sleep ??
      (async (ms: number) => {
        sleeps.push(ms);
      }),
  };

  return { ctx, logger, sleeps };
}
