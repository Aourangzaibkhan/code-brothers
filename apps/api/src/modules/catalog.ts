/**
 * Master Product Catalog & Cross-Platform SKU Mapper (spec §7.2, §9
 * `sku_mappings`).
 *
 * One master SKU links to at most one SKU per channel for a merchant, and
 * each channel SKU is unique per merchant (mirrors the unique indexes in
 * migration 0010). A sale on any channel resolves the master SKU and
 * deducts the same quantity from the stock ledger of every channel, so
 * Shopify, Daraz and the local store can never oversell the same unit.
 */
import type { FastifyInstance } from 'fastify';
import { nowIso, num, str, userId, type OpsContext } from './context.js';
import {
  CHANNELS,
  type Channel,
  type SkuMappingRecord,
} from './state.js';

const SKU_FIELD: Record<Channel, 'shopifySku' | 'darazSku' | 'localSku'> = {
  shopify: 'shopifySku',
  daraz: 'darazSku',
  local: 'localSku',
};

function view(m: SkuMappingRecord): Record<string, unknown> {
  return {
    id: m.id,
    masterSku: m.masterSku,
    shopifySku: m.shopifySku,
    shopifyProductId: m.shopifyProductId,
    darazSku: m.darazSku,
    darazItemId: m.darazItemId,
    localSku: m.localSku,
    localProductId: m.localProductId,
    prices: m.prices,
    stock: m.stock,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function readStock(value: unknown, base?: Record<Channel, number>): Record<Channel, number> {
  const stock: Record<Channel, number> = base ?? { shopify: 0, daraz: 0, local: 0 };
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>;
    for (const channel of CHANNELS) {
      const n = num(raw[channel]);
      if (n !== undefined) stock[channel] = Math.max(0, Math.floor(n));
    }
  }
  return stock;
}

function readPrices(value: unknown, base?: SkuMappingRecord['prices']): SkuMappingRecord['prices'] {
  const prices: SkuMappingRecord['prices'] = { ...(base ?? {}) };
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>;
    for (const channel of CHANNELS) {
      const n = num(raw[channel]);
      if (n !== undefined) prices[channel] = n;
    }
  }
  return prices;
}

export function registerCatalogRoutes(app: FastifyInstance, ctx: OpsContext): void {
  const { ops, requireAuth } = ctx;

  /** Returns a conflict description when a create/patch breaks §9 uniqueness. */
  function findConflict(
    ownerId: string,
    candidate: Partial<SkuMappingRecord>,
    excludeId?: string,
  ): string | undefined {
    for (const m of ops.skuMappings.values()) {
      if (m.userId !== ownerId || m.id === excludeId) continue;
      if (candidate.masterSku && m.masterSku === candidate.masterSku) {
        return `masterSku "${candidate.masterSku}" is already mapped`;
      }
      for (const channel of CHANNELS) {
        const field = SKU_FIELD[channel];
        const value = candidate[field];
        if (value && m[field] === value) {
          return `${channel} SKU "${value}" is already mapped to master SKU "${m.masterSku}"`;
        }
      }
    }
    return undefined;
  }

  app.post('/api/catalog/sku-mappings', { preHandler: requireAuth }, async (req, reply) => {
    const owner = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const masterSku = str(body.masterSku);
    if (!masterSku) {
      return reply.code(400).send({ error: 'validation_error', message: 'masterSku is required' });
    }
    const candidate: Partial<SkuMappingRecord> = {
      masterSku,
      shopifySku: str(body.shopifySku),
      darazSku: str(body.darazSku),
      localSku: str(body.localSku),
    };
    const conflict = findConflict(owner, candidate);
    if (conflict) return reply.code(409).send({ error: 'sku_conflict', message: conflict });

    const ts = nowIso(ctx);
    const record: SkuMappingRecord = {
      id: ops.newId(),
      userId: owner,
      masterSku,
      shopifySku: candidate.shopifySku,
      shopifyProductId: str(body.shopifyProductId),
      darazSku: candidate.darazSku,
      darazItemId: str(body.darazItemId),
      localSku: candidate.localSku,
      localProductId: str(body.localProductId),
      prices: readPrices(body.prices),
      stock: readStock(body.stock),
      createdAt: ts,
      updatedAt: ts,
    };
    ops.skuMappings.set(record.id, record);
    return reply.code(201).send(view(record));
  });

  app.get('/api/catalog/sku-mappings', { preHandler: requireAuth }, async (req) => {
    const owner = userId(req);
    const rows = [...ops.skuMappings.values()].filter((m) => m.userId === owner);
    return { mappings: rows.map(view) };
  });

  app.get<{ Params: { id: string } }>(
    '/api/catalog/sku-mappings/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = ops.skuMappings.get(req.params.id);
      if (!record || record.userId !== userId(req)) {
        return reply.code(404).send({ error: 'sku_mapping_not_found' });
      }
      return view(record);
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/catalog/sku-mappings/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const owner = userId(req);
      const record = ops.skuMappings.get(req.params.id);
      if (!record || record.userId !== owner) {
        return reply.code(404).send({ error: 'sku_mapping_not_found' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Partial<SkuMappingRecord> = {};
      const masterSku = str(body.masterSku);
      if (masterSku) patch.masterSku = masterSku;
      for (const channel of CHANNELS) {
        const field = SKU_FIELD[channel];
        if (body[field] === null) patch[field] = undefined;
        else {
          const value = str(body[field]);
          if (value) patch[field] = value;
        }
      }
      const conflict = findConflict(owner, patch, record.id);
      if (conflict) return reply.code(409).send({ error: 'sku_conflict', message: conflict });

      const next: SkuMappingRecord = {
        ...record,
        ...patch,
        shopifyProductId:
          body.shopifyProductId === null ? undefined : (str(body.shopifyProductId) ?? record.shopifyProductId),
        darazItemId:
          body.darazItemId === null ? undefined : (str(body.darazItemId) ?? record.darazItemId),
        localProductId:
          body.localProductId === null ? undefined : (str(body.localProductId) ?? record.localProductId),
        prices: readPrices(body.prices, record.prices),
        stock: readStock(body.stock, { ...record.stock }),
        updatedAt: nowIso(ctx),
      };
      ops.skuMappings.set(next.id, next);
      return view(next);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/catalog/sku-mappings/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = ops.skuMappings.get(req.params.id);
      if (!record || record.userId !== userId(req)) {
        return reply.code(404).send({ error: 'sku_mapping_not_found' });
      }
      ops.skuMappings.delete(record.id);
      return reply.code(204).send();
    },
  );

  /**
   * A sale happened on one channel: resolve its SKU to the master SKU,
   * deduct the sold quantity from the source channel's ledger, and apply
   * (and return) the matching deduction plan for every other channel.
   */
  app.post('/api/catalog/sync-sale', { preHandler: requireAuth }, async (req, reply) => {
    const owner = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const channel = str(body.channel) as Channel | undefined;
    const channelSku = str(body.channelSku);
    const qty = num(body.qty);
    if (!channel || !CHANNELS.includes(channel) || !channelSku || qty === undefined || qty <= 0) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'channel (shopify|daraz|local), channelSku and a positive qty are required',
      });
    }
    const field = SKU_FIELD[channel];
    const mapping = [...ops.skuMappings.values()].find(
      (m) => m.userId === owner && m[field] === channelSku,
    );
    if (!mapping) {
      return reply.code(404).send({ error: 'sku_mapping_not_found', message: `No master SKU maps ${channel} SKU "${channelSku}"` });
    }

    const quantity = Math.floor(qty);
    const stock: Record<Channel, number> = { ...mapping.stock };
    const sourceBefore = stock[channel];
    const sourceApplied = Math.min(sourceBefore, quantity);
    stock[channel] = sourceBefore - sourceApplied;

    const plan = CHANNELS.filter((c) => c !== channel).map((other) => {
      const before = stock[other];
      const deductQty = Math.min(before, quantity);
      stock[other] = before - deductQty;
      return {
        channel: other,
        channelSku: mapping[SKU_FIELD[other]],
        masterSku: mapping.masterSku,
        deductQty,
        stockBefore: before,
        stockAfter: stock[other],
        clamped: deductQty < quantity,
      };
    });

    const next: SkuMappingRecord = { ...mapping, stock, updatedAt: nowIso(ctx) };
    ops.skuMappings.set(next.id, next);
    await ctx.audit(req, {
      userId: owner,
      eventType: 'sku_stock_synced',
      details: { masterSku: mapping.masterSku, channel, channelSku, qty: quantity },
    });
    return {
      masterSku: mapping.masterSku,
      channel,
      channelSku,
      qty: quantity,
      source: {
        channel,
        channelSku,
        deductQty: sourceApplied,
        stockBefore: sourceBefore,
        stockAfter: stock[channel],
        clamped: sourceApplied < quantity,
      },
      plan,
      stock,
    };
  });
}
