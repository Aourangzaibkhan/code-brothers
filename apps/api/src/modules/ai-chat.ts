/**
 * AI Copilot chat endpoint (gap 5): `POST /api/ai/chat`.
 *
 * Wires the @code-brothers/ai-engine HybridRouter to a real HTTP endpoint
 * so the dashboard's Copilot drawer talks to a real model instead of the
 * local keyword matcher in apps/web/src/canvas/copilot.ts. The matcher
 * stays as a fallback (it generates runnable workflow graphs, which the
 * chat does not) — but the UI now says so honestly when no provider is
 * configured.
 *
 * Provider configuration (all env, all optional; comma-separated lists
 * rotate keys):
 *   OLLAMA_HOST        local Ollama, e.g. http://localhost:11434
 *                      (compose sets http://host.docker.internal:11434)
 *   GEMINI_API_KEY     Google Gemini (free tier)
 *   GROQ_API_KEY       Groq (free tier)
 *   OPENROUTER_API_KEY OpenRouter (free models)
 * Order: Ollama first (local, free), then Gemini, Groq, OpenRouter.
 *
 * Honest failure modes — no live keys exist in this repo, and none are
 * faked here:
 *   - No provider configured at all -> 503 `no_ai_provider_configured`.
 *   - Every configured provider failed (Ollama down, bad key, quota) ->
 *     502 `all_ai_providers_failed` with the per-provider attempt detail.
 * The endpoint never pretends a keyword match is an AI answer.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AllProvidersFailedError,
  GeminiProvider,
  GroqProvider,
  HybridRouter,
  OllamaProvider,
  OpenRouterProvider,
  type ChatMessage,
  type ChatProvider,
} from '@code-brothers/ai-engine';

/** Split a comma-separated env key list, dropping empties. */
export function splitKeys(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

export interface AiRouterConfig {
  ollamaHost?: string;
  geminiKeys?: string[];
  groqKeys?: string[];
  openRouterKeys?: string[];
  ollamaModel?: string;
  geminiModel?: string;
  groqModel?: string;
  openRouterModel?: string;
}

export interface NamedRouter {
  router: HybridRouter | null;
  providerNames: string[];
}

/** Build the router and remember its provider names for the status endpoint. */
export function buildNamedAiRouter(config: AiRouterConfig): NamedRouter {
  const providers: ChatProvider[] = [];
  if (config.ollamaHost) {
    providers.push(
      new OllamaProvider({ baseUrl: config.ollamaHost, model: config.ollamaModel }),
    );
  }
  if (config.geminiKeys && config.geminiKeys.length > 0) {
    providers.push(
      new GeminiProvider({ apiKeys: config.geminiKeys, model: config.geminiModel }),
    );
  }
  if (config.groqKeys && config.groqKeys.length > 0) {
    providers.push(new GroqProvider({ apiKeys: config.groqKeys, model: config.groqModel }));
  }
  if (config.openRouterKeys && config.openRouterKeys.length > 0) {
    providers.push(
      new OpenRouterProvider({ apiKeys: config.openRouterKeys, model: config.openRouterModel }),
    );
  }
  if (providers.length === 0) return { router: null, providerNames: [] };
  return { router: new HybridRouter(providers), providerNames: providers.map((p) => p.name) };
}

export function buildNamedAiRouterFromEnv(env: NodeJS.ProcessEnv = process.env): NamedRouter {
  return buildNamedAiRouter({
    ollamaHost: env.OLLAMA_HOST,
    geminiKeys: splitKeys(env.GEMINI_API_KEY),
    groqKeys: splitKeys(env.GROQ_API_KEY),
    openRouterKeys: splitKeys(env.OPENROUTER_API_KEY),
    ollamaModel: env.OLLAMA_MODEL,
    geminiModel: env.GEMINI_MODEL,
    groqModel: env.GROQ_MODEL,
    openRouterModel: env.OPENROUTER_MODEL,
  });
}

const SYSTEM_PROMPT = [
  'You are the Code Brothers Copilot, the AI assistant inside the Code Brothers',
  'workflow-automation dashboard. The user builds no-code automations from',
  'nodes (triggers, actions, conditions) for WhatsApp, Shopify, Daraz,',
  'Instagram, YouTube, couriers and their own store. Answer concisely and',
  'concretely: name the nodes to use, in order, when the user asks how to',
  'automate something. If a request cannot be done with the available nodes,',
  'say so plainly instead of inventing a node.',
].join(' ');

const MAX_MESSAGES = 50;
const MAX_CONTENT_CHARS = 8000;

export interface AiRouteDeps {
  /** Null when no provider is configured — the route answers 503. */
  ai: NamedRouter;
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

function parseMessages(body: unknown): { messages?: ChatMessage[]; error?: string } {
  if (!body || typeof body !== 'object') return { error: 'messages are required' };
  const raw = (body as Record<string, unknown>)['messages'];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'messages must be a non-empty array' };
  }
  if (raw.length > MAX_MESSAGES) {
    return { error: `at most ${MAX_MESSAGES} messages per request` };
  }
  const messages: ChatMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return { error: 'each message needs role + content' };
    const role = (entry as Record<string, unknown>)['role'];
    const content = (entry as Record<string, unknown>)['content'];
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return { error: 'message role must be system, user or assistant' };
    }
    if (typeof content !== 'string' || content.trim() === '') {
      return { error: 'message content must be a non-empty string' };
    }
    if (content.length > MAX_CONTENT_CHARS) {
      return { error: `message content is limited to ${MAX_CONTENT_CHARS} characters` };
    }
    messages.push({ role, content });
  }
  return { messages };
}

export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const { ai, requireAuth } = deps;

  app.get('/api/ai/status', { preHandler: requireAuth }, async () => ({
    configured: ai.router !== null,
    providers: ai.providerNames,
    coolingDown: ai.router ? ai.router.coolingDown() : [],
    message:
      ai.router !== null
        ? `AI assistant ready via ${ai.providerNames.join(', ')}.`
        : 'No AI provider is configured. Set OLLAMA_HOST or a GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY to enable the assistant; until then the Copilot uses its built-in workflow generator.',
  }));

  app.post('/api/ai/chat', { preHandler: requireAuth }, async (req, reply) => {
    if (!ai.router) {
      return reply.code(503).send({
        error: 'no_ai_provider_configured',
        message:
          'No AI provider is configured. Set OLLAMA_HOST or a GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY and restart the API.',
        providers: [],
      });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseMessages(body);
    if (parsed.error || !parsed.messages) {
      return reply.code(400).send({ error: 'validation_error', message: parsed.error });
    }
    const temperature =
      typeof body.temperature === 'number'
        ? Math.min(2, Math.max(0, body.temperature))
        : undefined;
    const maxTokens =
      typeof body.maxTokens === 'number'
        ? Math.min(4096, Math.max(1, Math.floor(body.maxTokens)))
        : 1024;
    const model = typeof body.model === 'string' ? body.model : undefined;
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...parsed.messages,
    ];
    try {
      const outcome = await ai.router.route(messages, { model, temperature, maxTokens });
      return {
        text: outcome.result.text,
        provider: outcome.provider,
        model: outcome.result.model,
        usage: outcome.result.usage ?? undefined,
        attempts: outcome.attempts,
      };
    } catch (err) {
      if (err instanceof AllProvidersFailedError) {
        return reply.code(502).send({
          error: 'all_ai_providers_failed',
          message: `Every configured AI provider failed: ${err.message}`,
          attempts: err.attempts,
        });
      }
      throw err;
    }
  });
}
