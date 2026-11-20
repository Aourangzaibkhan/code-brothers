/**
 * Unified Live Inbox, Human Takeover (HITL) and the Admin Approval Queue
 * (spec §7.1).
 *
 * WhatsApp and Instagram messages land in one conversation store. While
 * a conversation is not paused, inbound messages go through the
 * pluggable auto-responder (a rule-based responder by default). The
 * moment a human replies — or takeover is switched on — the AI pauses
 * for that customer for a configurable window (default 30 minutes),
 * exactly as §7.1 requires.
 *
 * High-risk actions (refunds, discounts, broadcasts…) are created as
 * pending approvals. Only the owner can approve/reject; approving runs
 * the executor registered for the action type. The built-in demo
 * executor for "send_message" records the send (and appends it to the
 * target conversation when one is named).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nowIso, num, str, userId, type OpsContext } from './context.js';
import type {
  ApprovalRecord,
  AutoResponder,
  ConversationRecord,
  InboxChannel,
  InboxMessageRecord,
  SentMessageRecord,
} from './state.js';

export const DEFAULT_TAKEOVER_WINDOW_MINUTES = 30;

/** Simple rule-based auto-responder (the default AutoResponder). */
export const ruleBasedResponder: AutoResponder = ({ message }) => {
  const text = message.body.toLowerCase();
  if (/\b(price|cost|rate|charges|delivery charges)\b/.test(text)) {
    return 'Thanks for asking! Our team will confirm the latest price and delivery charges for you right here in a moment.';
  }
  if (/\b(track|tracking|order status|where is my order|awb)\b/.test(text)) {
    return 'I can check that for you — please share your order id or the AWB number from your confirmation message.';
  }
  if (/\b(refund|return|exchange|damaged|broken)\b/.test(text)) {
    return 'Sorry to hear that. Your request has been noted — refunds and returns need a quick owner approval, and we will update you on this chat.';
  }
  if (/^(hi|hello|hey|salam|aoa|assalam)/.test(text.trim())) {
    return 'Hello! Welcome to our store. How can I help you today?';
  }
  return 'Thanks for your message! Our team will reply shortly. If this is about an order, please share your order id.';
};

function conversationView(
  ctx: OpsContext,
  c: ConversationRecord,
): Record<string, unknown> {
  const messages = [...ctx.ops.messages.values()].filter((m) => m.conversationId === c.id);
  const last = messages[messages.length - 1];
  return {
    id: c.id,
    channel: c.channel,
    externalId: c.externalId,
    displayName: c.displayName,
    customerId: c.customerId,
    aiPaused: c.aiPaused,
    pausedUntil: c.pausedUntil,
    messageCount: messages.length,
    lastMessage: last ? { body: last.body, sender: last.sender, direction: last.direction, createdAt: last.createdAt } : undefined,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function messageView(m: InboxMessageRecord): Record<string, unknown> {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    sender: m.sender,
    body: m.body,
    createdAt: m.createdAt,
  };
}

function approvalView(a: ApprovalRecord): Record<string, unknown> {
  return {
    id: a.id,
    type: a.type,
    payload: a.payload,
    status: a.status,
    requestedBy: a.requestedBy,
    decidedBy: a.decidedBy,
    decisionNote: a.decisionNote,
    executionResult: a.executionResult,
    executionError: a.executionError,
    createdAt: a.createdAt,
    decidedAt: a.decidedAt,
  };
}

export function registerInboxRoutes(app: FastifyInstance, ctx: OpsContext): void {
  const { ops, requireAuth, requireOwner } = ctx;
  if (!ops.autoResponder) ops.autoResponder = ruleBasedResponder;

  // Demo executor: an approved "send_message" action actually sends —
  // recorded in the sent-messages log and mirrored into the conversation.
  if (!ops.executors.has('send_message')) {
    ops.registerExecutor('send_message', (payload, execCtx) => {
      const sent: SentMessageRecord = {
        id: execCtx.ops.newId(),
        userId: execCtx.userId,
        channel: typeof payload.channel === 'string' ? payload.channel : undefined,
        to:
          typeof payload.to === 'string'
            ? payload.to
            : typeof payload.externalId === 'string'
              ? payload.externalId
              : undefined,
        body:
          typeof payload.body === 'string'
            ? payload.body
            : typeof payload.text === 'string'
              ? payload.text
              : undefined,
        approvalId: execCtx.approvalId,
        sentAt: new Date().toISOString(),
      };
      execCtx.ops.sentMessages.push(sent);
      const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : undefined;
      if (conversationId && sent.body) {
        const conversation = execCtx.ops.conversations.get(conversationId);
        if (conversation) {
          const message: InboxMessageRecord = {
            id: execCtx.ops.newId(),
            conversationId,
            direction: 'out',
            sender: 'human',
            body: sent.body,
            createdAt: sent.sentAt,
          };
          execCtx.ops.messages.set(message.id, message);
        }
      }
      return { sentMessageId: sent.id, to: sent.to, channel: sent.channel };
    });
  }

  function findConversation(owner: string, channel: InboxChannel, externalId: string): ConversationRecord | undefined {
    for (const c of ops.conversations.values()) {
      if (c.userId === owner && c.channel === channel && c.externalId === externalId) return c;
    }
    return undefined;
  }

  function ownedConversation(req: FastifyRequest, id: string): ConversationRecord | undefined {
    const conversation = ops.conversations.get(id);
    if (!conversation || conversation.userId !== userId(req)) return undefined;
    return conversation;
  }

  function appendMessage(
    conversationId: string,
    direction: 'in' | 'out',
    sender: InboxMessageRecord['sender'],
    body: string,
  ): InboxMessageRecord {
    const message: InboxMessageRecord = {
      id: ops.newId(),
      conversationId,
      direction,
      sender,
      body,
      createdAt: nowIso(ctx),
    };
    ops.messages.set(message.id, message);
    return message;
  }

  // -- ingest a normalized channel message -----------------------------------
  app.post('/api/inbox/messages', { preHandler: requireAuth }, async (req, reply) => {
    const owner = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const channel = str(body.channel) as InboxChannel | undefined;
    const externalId = str(body.externalId) ?? str(body.from);
    const text = str(body.body) ?? str(body.text);
    if ((channel !== 'whatsapp' && channel !== 'instagram') || !externalId || !text) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'channel (whatsapp|instagram), externalId and body are required',
      });
    }

    let conversation = findConversation(owner, channel, externalId);
    if (!conversation) {
      const ts = nowIso(ctx);
      conversation = {
        id: ops.newId(),
        userId: owner,
        channel,
        externalId,
        displayName: str(body.displayName) ?? str(body.name),
        customerId: str(body.customerId),
        aiPaused: false,
        createdAt: ts,
        updatedAt: ts,
      };
      ops.conversations.set(conversation.id, conversation);
    }

    // A takeover window that has expired releases the AI automatically.
    if (conversation.aiPaused && conversation.pausedUntil && Date.parse(conversation.pausedUntil) <= ctx.now()) {
      conversation = { ...conversation, aiPaused: false, pausedUntil: undefined, updatedAt: nowIso(ctx) };
      ops.conversations.set(conversation.id, conversation);
    }

    const message = appendMessage(conversation.id, 'in', 'customer', text);
    ops.conversations.set(conversation.id, { ...conversation, updatedAt: nowIso(ctx) });

    let autoReply: InboxMessageRecord | undefined;
    if (!conversation.aiPaused && ops.autoResponder) {
      const replyText = await ops.autoResponder({ conversation, message });
      if (replyText) autoReply = appendMessage(conversation.id, 'out', 'ai', replyText);
    }
    const fresh = ops.conversations.get(conversation.id) as ConversationRecord;
    return reply.code(201).send({
      conversation: conversationView(ctx, fresh),
      message: messageView(message),
      autoReply: autoReply ? messageView(autoReply) : undefined,
      aiPaused: fresh.aiPaused,
    });
  });

  app.get('/api/inbox/conversations', { preHandler: requireAuth }, async (req) => {
    const owner = userId(req);
    const rows = [...ops.conversations.values()]
      .filter((c) => c.userId === owner)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { conversations: rows.map((c) => conversationView(ctx, c)) };
  });

  app.get<{ Params: { id: string } }>(
    '/api/inbox/conversations/:id/messages',
    { preHandler: requireAuth },
    async (req, reply) => {
      const conversation = ownedConversation(req, req.params.id);
      if (!conversation) return reply.code(404).send({ error: 'conversation_not_found' });
      const messages = [...ops.messages.values()]
        .filter((m) => m.conversationId === conversation.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { conversation: conversationView(ctx, conversation), messages: messages.map(messageView) };
    },
  );

  // -- human takeover ----------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/inbox/conversations/:id/takeover',
    { preHandler: requireAuth },
    async (req, reply) => {
      const conversation = ownedConversation(req, req.params.id);
      if (!conversation) return reply.code(404).send({ error: 'conversation_not_found' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const paused = body.paused !== false; // default: take over (pause the AI)
      const windowMinutes = num(body.windowMinutes) ?? DEFAULT_TAKEOVER_WINDOW_MINUTES;
      const next: ConversationRecord = {
        ...conversation,
        aiPaused: paused,
        pausedUntil: paused ? new Date(ctx.now() + windowMinutes * 60_000).toISOString() : undefined,
        updatedAt: nowIso(ctx),
      };
      ops.conversations.set(next.id, next);
      return { conversation: conversationView(ctx, next) };
    },
  );

  // -- human reply (auto-pauses the AI, §7.1) ----------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/inbox/conversations/:id/reply',
    { preHandler: requireAuth },
    async (req, reply) => {
      const conversation = ownedConversation(req, req.params.id);
      if (!conversation) return reply.code(404).send({ error: 'conversation_not_found' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = str(body.body) ?? str(body.text);
      if (!text) {
        return reply.code(400).send({ error: 'validation_error', message: 'body is required' });
      }
      const message = appendMessage(conversation.id, 'out', 'human', text);
      const windowMinutes = num(body.windowMinutes) ?? DEFAULT_TAKEOVER_WINDOW_MINUTES;
      const next: ConversationRecord = {
        ...conversation,
        aiPaused: true,
        pausedUntil: new Date(ctx.now() + windowMinutes * 60_000).toISOString(),
        updatedAt: nowIso(ctx),
      };
      ops.conversations.set(next.id, next);
      return reply.code(201).send({ message: messageView(message), conversation: conversationView(ctx, next) });
    },
  );

  // -- approval queue ------------------------------------------------------------
  app.post('/api/approvals', { preHandler: requireAuth }, async (req, reply) => {
    const owner = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = str(body.type);
    if (!type) {
      return reply.code(400).send({ error: 'validation_error', message: 'type is required (e.g. refund, discount, send_message)' });
    }
    const approval: ApprovalRecord = {
      id: ops.newId(),
      userId: owner,
      type,
      payload:
        body.payload && typeof body.payload === 'object'
          ? (body.payload as Record<string, unknown>)
          : {},
      status: 'pending',
      requestedBy: str(body.requestedBy),
      createdAt: nowIso(ctx),
    };
    ops.approvals.set(approval.id, approval);
    return reply.code(201).send(approvalView(approval));
  });

  app.get('/api/approvals', { preHandler: requireAuth }, async (req) => {
    const owner = userId(req);
    const query = req.query as { status?: string };
    let rows = [...ops.approvals.values()].filter((a) => a.userId === owner);
    if (query.status) rows = rows.filter((a) => a.status === query.status);
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { approvals: rows.map(approvalView) };
  });

  app.get<{ Params: { id: string } }>(
    '/api/approvals/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const approval = ops.approvals.get(req.params.id);
      if (!approval || approval.userId !== userId(req)) {
        return reply.code(404).send({ error: 'approval_not_found' });
      }
      return approvalView(approval);
    },
  );

  async function decide(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    action: 'approve' | 'reject',
  ) {
    const approval = ops.approvals.get(req.params.id);
    if (!approval || approval.userId !== userId(req)) {
      return reply.code(404).send({ error: 'approval_not_found' });
    }
    if (approval.status !== 'pending') {
      return reply.code(409).send({ error: 'approval_already_decided', status: approval.status });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decided: ApprovalRecord = {
      ...approval,
      decidedBy: userId(req),
      decisionNote: str(body.note),
      decidedAt: nowIso(ctx),
      status: action === 'reject' ? 'rejected' : 'approved',
    };
    if (action === 'approve') {
      const executor = ops.executors.get(approval.type);
      if (executor) {
        try {
          decided.executionResult = await executor(approval.payload, {
            ops,
            userId: approval.userId,
            approvalId: approval.id,
          });
          decided.status = 'executed';
        } catch (err) {
          decided.status = 'failed';
          decided.executionError = err instanceof Error ? err.message : 'executor failed';
        }
      }
    }
    ops.approvals.set(decided.id, decided);
    await ctx.audit(req, {
      userId: approval.userId,
      eventType: action === 'approve' ? 'approval_approved' : 'approval_rejected',
      severity: 'warning',
      details: { approvalId: approval.id, type: approval.type, status: decided.status },
    });
    return approvalView(decided);
  }

  app.post<{ Params: { id: string } }>(
    '/api/approvals/:id/approve',
    { preHandler: [requireAuth, requireOwner] },
    async (req, reply) => decide(req, reply, 'approve'),
  );

  app.post<{ Params: { id: string } }>(
    '/api/approvals/:id/reject',
    { preHandler: [requireAuth, requireOwner] },
    async (req, reply) => decide(req, reply, 'reject'),
  );

  /** Sent-messages log written by the demo "send_message" executor. */
  app.get('/api/inbox/sent', { preHandler: requireAuth }, async (req) => {
    const owner = userId(req);
    return { sent: ops.sentMessages.filter((s) => s.userId === owner) };
  });
}
