/**
 * Pluggable Courier Hub (spec §7.4).
 *
 * Thin HTTP surface over @code-brothers/connector-couriers: every route
 * builds a `CourierClient` from the named preset, so booking/tracking
 * wire formats stay in the connector package. The HTTP transport is
 * injectable (ApiOptions.courierFetch) — production uses global fetch,
 * tests pass the connector's mock. Credentials come from the request
 * (in production they are resolved from the vault by the caller), then
 * ApiOptions.courierCredentials, then a clearly-marked placeholder so
 * sandbox/mock transports work without real secrets.
 */
import type { FastifyInstance } from 'fastify';
import {
  COURIER_PRESETS,
  CourierApiError,
  CourierClient,
  type BookingRequest,
  type CourierCredentials,
} from '@code-brothers/connector-couriers';
import { str, type OpsContext } from './context.js';

const PLACEHOLDER_CREDENTIALS: CourierCredentials = {
  apiKey: 'unauthenticated',
  token: 'unauthenticated',
  username: 'unauthenticated',
  password: 'unauthenticated',
};

export function registerCourierRoutes(app: FastifyInstance, ctx: OpsContext): void {
  const { requireAuth } = ctx;

  function clientFor(
    presetId: string,
    credentials?: CourierCredentials,
    baseUrl?: string,
  ): CourierClient | undefined {
    const preset = COURIER_PRESETS.find((p) => p.id === presetId);
    if (!preset) return undefined;
    return new CourierClient({
      preset,
      credentials: credentials ?? ctx.courierCredentials ?? PLACEHOLDER_CREDENTIALS,
      fetch: ctx.courierFetch,
      baseUrl: baseUrl ?? ctx.courierBaseUrl,
    });
  }

  app.get('/api/couriers/presets', { preHandler: requireAuth }, async () => ({
    presets: COURIER_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      region: p.region,
      baseUrl: p.baseUrl,
      authType: p.auth.type,
    })),
  }));

  app.post('/api/couriers/book', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const presetId = str(body.preset);
    const shipment = body.shipment as BookingRequest | undefined;
    if (!presetId || !shipment || typeof shipment !== 'object' || !shipment.receiver || !shipment.sender) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'preset and shipment {sender, receiver, weightKg} are required',
      });
    }
    const client = clientFor(
      presetId,
      body.credentials as CourierCredentials | undefined,
      str(body.baseUrl),
    );
    if (!client) {
      return reply.code(400).send({
        error: 'unknown_preset',
        message: `Unknown courier preset "${presetId}". Known: ${COURIER_PRESETS.map((p) => p.id).join(', ')}`,
      });
    }
    try {
      const result = await client.bookShipment(shipment);
      return reply.code(201).send({ preset: presetId, awb: result.awb, labelUrl: result.labelUrl });
    } catch (err) {
      if (err instanceof CourierApiError) {
        return reply.code(502).send({ error: 'courier_upstream_error', status: err.status, message: err.message });
      }
      return reply.code(502).send({
        error: 'courier_booking_failed',
        message: err instanceof Error ? err.message : 'booking failed',
      });
    }
  });

  app.get<{ Params: { preset: string; trackingId: string } }>(
    '/api/couriers/track/:preset/:trackingId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const client = clientFor(req.params.preset);
      if (!client) {
        return reply.code(400).send({ error: 'unknown_preset', message: `Unknown courier preset "${req.params.preset}"` });
      }
      try {
        const tracking = await client.track(req.params.trackingId);
        return { preset: req.params.preset, ...tracking };
      } catch (err) {
        if (err instanceof CourierApiError) {
          return reply.code(502).send({ error: 'courier_upstream_error', status: err.status, message: err.message });
        }
        return reply.code(502).send({
          error: 'courier_tracking_failed',
          message: err instanceof Error ? err.message : 'tracking failed',
        });
      }
    },
  );
}
