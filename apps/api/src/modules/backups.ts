/**
 * Encrypted Backups (spec §7.6: "Zero-Config Tunnel & Encrypted
 * Backups" — AES-256 encrypted backups the owner controls).
 *
 * Create: every ops store (catalog, customers, orders, TID ledger,
 * inbox, approvals) is snapshotted to JSON and sealed with the vault's
 * AES-256-GCM envelope encryption under CB_MASTER_KEY. The sealed
 * record is returned as ONE base64url `bundle` string — deliberately
 * not as a nested JSON object, because the platform's redaction
 * middleware (spec §8C) would (correctly) refuse to let vault fields
 * such as `wrappedDek` travel in a normal JSON response.
 *
 * Restore (owner-only): unseals the bundle and repopulates the stores
 * wholesale — the round-trip is covered by tests.
 */
import type { FastifyInstance } from 'fastify';
import { decryptSecret, encryptSecret, type EncryptedSecret } from '@code-brothers/security';
import { nowIso, userId, type OpsContext } from './context.js';
import type { OpsSnapshot } from './state.js';

const BUNDLE_FORMAT = 'code-brothers-backup/v1';

interface BackupEnvelope {
  format: string;
  version: 1;
  exportedAt: string;
  data: OpsSnapshot;
}

export function registerBackupRoutes(app: FastifyInstance, ctx: OpsContext): void {
  const { ops, requireAuth, requireOwner, masterKey } = ctx;
  const ownerOnly = [requireAuth, requireOwner];

  app.post('/api/backups/create', { preHandler: ownerOnly }, async (req, reply) => {
    const envelope: BackupEnvelope = {
      format: BUNDLE_FORMAT,
      version: 1,
      exportedAt: nowIso(ctx),
      data: ops.snapshot(),
    };
    const sealed = encryptSecret(JSON.stringify(envelope), masterKey);
    const bundle = Buffer.from(JSON.stringify(sealed), 'utf8').toString('base64url');
    await ctx.audit(req, {
      userId: userId(req),
      eventType: 'backup_created',
      details: { counts: ops.counts() },
    });
    return reply.code(201).send({
      format: BUNDLE_FORMAT,
      createdAt: envelope.exportedAt,
      counts: ops.counts(),
      bundle,
    });
  });

  app.post('/api/backups/restore', { preHandler: ownerOnly }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let sealed: EncryptedSecret | undefined;
    if (typeof body.bundle === 'string' && body.bundle !== '') {
      try {
        sealed = JSON.parse(Buffer.from(body.bundle, 'base64url').toString('utf8')) as EncryptedSecret;
      } catch {
        return reply.code(400).send({ error: 'invalid_backup', message: 'bundle is not valid base64url JSON' });
      }
    } else if (body.encrypted && typeof body.encrypted === 'object') {
      sealed = body.encrypted as EncryptedSecret;
    }
    if (!sealed) {
      return reply.code(400).send({ error: 'validation_error', message: 'bundle (from POST /api/backups/create) is required' });
    }

    let envelope: BackupEnvelope;
    try {
      envelope = JSON.parse(decryptSecret(sealed, masterKey)) as BackupEnvelope;
    } catch {
      return reply.code(400).send({ error: 'invalid_backup', message: 'bundle could not be decrypted with the vault master key' });
    }
    if (envelope.format !== BUNDLE_FORMAT || !envelope.data) {
      return reply.code(400).send({ error: 'invalid_backup', message: 'bundle is not a Code Brothers backup' });
    }
    ops.restore(envelope.data);
    await ctx.audit(req, {
      userId: userId(req),
      eventType: 'backup_restored',
      severity: 'warning',
      details: { exportedAt: envelope.exportedAt, counts: ops.counts() },
    });
    return { restored: true, exportedAt: envelope.exportedAt, counts: ops.counts() };
  });
}
