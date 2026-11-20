/**
 * Business/operations modules (spec §7) — registration entry point.
 * app.ts calls {@link registerOpsModules} once with the shared context;
 * each module adds its routes to the same Fastify instance.
 */
import type { FastifyInstance } from 'fastify';
import type { OpsContext } from './context.js';
import { registerCatalogRoutes } from './catalog.js';
import { registerCustomerRoutes } from './customers.js';
import { registerFraudRoutes } from './fraud.js';
import { registerPaymentRoutes } from './payments.js';
import { registerInboxRoutes } from './inbox.js';
import { registerCourierRoutes } from './couriers.js';
import { registerDigestRoutes } from './digest.js';
import { registerBackupRoutes } from './backups.js';

export type { OpsContext, CourierCredentials } from './context.js';
export { createOpsState, OpsState, type OpsSnapshot } from './state.js';
export { normalizePhone, isValidPhone } from './customers.js';
export {
  FRAUD_ALLOW_BELOW,
  FRAUD_BLOCK_AT,
  FRAUD_POINTS,
  decisionForScore,
  type FraudDecision,
} from './fraud.js';
export { buildDigest, type DigestSummary } from './digest.js';
export { ruleBasedResponder, DEFAULT_TAKEOVER_WINDOW_MINUTES } from './inbox.js';

export function registerOpsModules(app: FastifyInstance, ctx: OpsContext): void {
  registerCatalogRoutes(app, ctx);
  registerCustomerRoutes(app, ctx);
  registerFraudRoutes(app, ctx);
  registerPaymentRoutes(app, ctx);
  registerInboxRoutes(app, ctx);
  registerCourierRoutes(app, ctx);
  registerDigestRoutes(app, ctx);
  registerBackupRoutes(app, ctx);
}
