import { WorkflowEngine, type EngineOptions } from './engine.js';
import { createCoreNodeRegistry } from './nodes/index.js';

export * from './types.js';
export {
  evaluateExpression,
  renderTemplate,
  renderDeep,
  ExpressionError,
  type ExpressionData,
  type ExpressionOptions,
} from '@code-brothers/node-sdk';
export * from './cron.js';
export * from './ssrf.js';
export * from './queue.js';
export * from './engine.js';
export * from './nodes/index.js';

/** Convenience: an engine pre-loaded with all built-in core nodes. */
export function createEngine(options: EngineOptions = {}): WorkflowEngine {
  return new WorkflowEngine(createCoreNodeRegistry(), options);
}
