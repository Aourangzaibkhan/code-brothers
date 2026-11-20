import { NodeRegistry, type NodeDefinition } from '@code-brothers/node-sdk';
import { cronTriggerNode } from './cron-trigger.js';
import { httpRequestNode } from './http-request.js';
import { ifNode } from './if.js';
import { logNode } from './log.js';
import { loopNode } from './loop.js';
import { manualTriggerNode } from './manual-trigger.js';
import { noopNode } from './noop.js';
import { setDataNode } from './set-data.js';
import { switchNode } from './switch.js';
import { waitNode } from './wait.js';
import { webhookTriggerNode } from './webhook-trigger.js';

export { cronTriggerNode } from './cron-trigger.js';
export { httpRequestNode } from './http-request.js';
export { ifNode, evaluateCondition, valuesEqual } from './if.js';
export type { ConditionOperator } from './if.js';
export { logNode } from './log.js';
export { loopNode } from './loop.js';
export { manualTriggerNode } from './manual-trigger.js';
export { noopNode } from './noop.js';
export { setDataNode } from './set-data.js';
export type { SetDataAssignment } from './set-data.js';
export { switchNode } from './switch.js';
export type { SwitchCase } from './switch.js';
export { waitNode, MAX_WAIT_MS } from './wait.js';
export { webhookTriggerNode } from './webhook-trigger.js';
export type { WebhookRequestData } from './webhook-trigger.js';

/** All built-in core nodes, in palette order. */
export const coreNodes: NodeDefinition[] = [
  manualTriggerNode,
  webhookTriggerNode,
  cronTriggerNode,
  httpRequestNode,
  ifNode,
  switchNode,
  loopNode,
  waitNode,
  setDataNode,
  logNode,
  noopNode,
];

/** A fresh registry pre-loaded with the core nodes. */
export function createCoreNodeRegistry(): NodeRegistry {
  return new NodeRegistry().registerAll(coreNodes);
}
