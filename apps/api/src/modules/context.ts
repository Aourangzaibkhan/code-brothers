/**
 * Shared context handed to every ops module by app.ts: the ops state, the
 * platform stores (for the audit log), the vault master key, the auth
 * pre-handlers defined in app.ts, and the injectable courier transport.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CourierCredentials } from '@code-brothers/connector-couriers';
import type { Stores, UserRecord } from '../store.js';
import type { OpsState } from './state.js';

export type { CourierCredentials };

export interface OpsContext {
  ops: OpsState;
  stores: Stores;
  masterKey: Buffer;
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireOwner: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  audit: (
    req: FastifyRequest | undefined,
    entry: {
      userId?: string;
      eventType: string;
      severity?: 'info' | 'warning' | 'critical';
      details?: Record<string, unknown>;
    },
  ) => Promise<void>;
  now: () => number;
  /** Injectable courier HTTP transport (tests pass the connector's mock). */
  courierFetch?: typeof fetch;
  /** Fallback courier credentials when a request carries none. */
  courierCredentials?: CourierCredentials;
  /** Fallback courier base URL override (sandbox / local mock). */
  courierBaseUrl?: string;
}

export function userId(req: FastifyRequest): string {
  return (req.authUser as UserRecord).id;
}

export function nowIso(ctx: OpsContext): string {
  return new Date(ctx.now()).toISOString();
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
