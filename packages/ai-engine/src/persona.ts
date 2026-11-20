/**
 * Assistant persona definitions (spec §4B), matching the `ai_assistants`
 * table shape (§9): name, system prompt, tool whitelist, provider
 * preferences, plus per-user memory linkage via `ai_memories` at runtime.
 */

export type AssistantRole =
  | 'copilot'
  | 'sales'
  | 'order-tracking'
  | 'support'
  | 'comment-moderator'
  | 'custom';

export interface ProviderPrefs {
  /** Ordered provider names the HybridRouter should prefer. */
  preferred?: string[];
  model?: string;
  temperature?: number;
}

export interface AssistantPersona {
  id?: string;
  workspaceId?: string;
  name: string;
  role: AssistantRole;
  systemPrompt: string;
  /** Least-privilege tool whitelist — the agent can run nothing else. */
  toolWhitelist: string[];
  providerPrefs: ProviderPrefs;
  /** BCP-47-ish language tag or 'auto' for language auto-matching. */
  language?: string;
  tone?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function defineAssistant(
  persona: AssistantPersona,
): AssistantPersona {
  if (!persona.name?.trim()) throw new Error('assistant persona needs a name');
  if (!persona.systemPrompt?.trim()) {
    throw new Error(`assistant "${persona.name}" needs a systemPrompt`);
  }
  return {
    ...persona,
    toolWhitelist: [...(persona.toolWhitelist ?? [])],
    providerPrefs: { ...(persona.providerPrefs ?? {}) },
    language: persona.language ?? 'auto',
  };
}

/** Ready-made personas from spec §4B. */
export const DEFAULT_PERSONAS: AssistantPersona[] = [
  defineAssistant({
    name: 'Sales Assistant',
    role: 'sales',
    systemPrompt:
      'You are a friendly sales assistant for an online store. Answer product questions from the catalog, check live stock before promising anything, and help the customer place an order. Match the customer language. Never invent prices or stock.',
    toolWhitelist: ['search_catalog', 'check_stock', 'calculate_shipping', 'create_order'],
    providerPrefs: { preferred: ['ollama', 'gemini', 'groq', 'openrouter'] },
  }),
  defineAssistant({
    name: 'Order Tracking Assistant',
    role: 'order-tracking',
    systemPrompt:
      'You help customers track orders. Ask for the order id or phone number, look the order up, and report its real status and tracking link. Never guess a status.',
    toolWhitelist: ['lookup_order', 'get_tracking'],
    providerPrefs: { preferred: ['ollama', 'groq', 'gemini', 'openrouter'] },
  }),
  defineAssistant({
    name: 'Support & Returns Assistant',
    role: 'support',
    systemPrompt:
      'You handle support and returns politely. Diagnose the issue, offer the store policy from the knowledge base, and escalate to a human when the customer asks or the case is sensitive. Refunds and discounts always need human approval.',
    toolWhitelist: ['search_knowledge_base', 'lookup_order', 'escalate_to_human'],
    providerPrefs: { preferred: ['ollama', 'gemini', 'groq', 'openrouter'] },
  }),
  defineAssistant({
    name: 'Comment Moderator',
    role: 'comment-moderator',
    systemPrompt:
      'You moderate YouTube/Instagram comments: hide spam, reply helpfully to genuine questions in the commenter language, and flag purchase intent as a hot lead. Never argue with viewers.',
    toolWhitelist: ['hide_comment', 'reply_comment', 'flag_lead'],
    providerPrefs: { preferred: ['ollama', 'groq', 'openrouter', 'gemini'] },
  }),
];
