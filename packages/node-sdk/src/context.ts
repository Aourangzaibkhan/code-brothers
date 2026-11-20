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
 * evaluation is engine territory (it lives in @code-brothers/core), so by
 * default the expression methods throw a clear error unless the caller
 * injects an implementation.
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
      (() => {
        throw new Error(
          'evaluateExpression is not configured in this test context — inject one from @code-brothers/core',
        );
      }),
    renderTemplate:
      options.renderTemplate ??
      (() => {
        throw new Error(
          'renderTemplate is not configured in this test context — inject one from @code-brothers/core',
        );
      }),
    sleep:
      options.sleep ??
      (async (ms: number) => {
        sleeps.push(ms);
      }),
  };

  return { ctx, logger, sleeps };
}
