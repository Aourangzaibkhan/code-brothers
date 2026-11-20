/**
 * HybridRouter — the zero-cost hybrid AI router (spec §4C).
 *
 * Tries providers in order (typically: local Ollama first, then the free
 * cloud pool). Behaviour:
 *  - Key rotation: when a keyed provider fails with a retryable error
 *    (429 / 5xx / network), the router rotates to that provider's next key
 *    (round-robin) and retries the same provider once per key.
 *  - Fallback: when a provider's keys are exhausted, the router moves on
 *    to the next provider.
 *  - Cooldown: a provider that failed a whole route attempt is skipped
 *    until its cooldown expires; each consecutive failure lengthens the
 *    cooldown (multiplied), a success resets it.
 */

import {
  isRetryableError,
  ProviderError,
  type ChatMessage,
  type ChatOptions,
  type ChatProvider,
  type ChatResult,
  type KeyRotatingProvider,
} from './types.js';

export interface AttemptRecord {
  provider: string;
  keyIndex?: number;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface RouteOutcome {
  result: ChatResult;
  /** Name of the provider that ultimately answered. */
  provider: string;
  attempts: AttemptRecord[];
}

export interface HybridRouterOptions {
  /** Base cooldown after a provider fails, in ms. Default 30_000. */
  cooldownMs?: number;
  /** Clock, injectable for tests. Default Date.now. */
  now?: () => number;
}

interface ProviderState {
  failures: number;
  cooldownUntil: number;
}

function isKeyRotating(p: ChatProvider): p is KeyRotatingProvider {
  return typeof (p as KeyRotatingProvider).rotateKey === 'function';
}

export class AllProvidersFailedError extends Error {
  readonly attempts: AttemptRecord[];
  constructor(attempts: AttemptRecord[]) {
    const summary = attempts
      .map((a) => `${a.provider}${a.status ? ` (HTTP ${a.status})` : ''}: ${a.error ?? 'failed'}`)
      .join('; ');
    super(`all AI providers failed: ${summary || 'no provider available'}`);
    this.name = 'AllProvidersFailedError';
    this.attempts = attempts;
  }
}

export class HybridRouter implements ChatProvider {
  readonly name = 'hybrid-router';
  private readonly providers: ChatProvider[];
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly state = new Map<string, ProviderState>();

  constructor(providers: ChatProvider[], opts: HybridRouterOptions = {}) {
    if (!providers.length) throw new Error('HybridRouter needs at least one provider');
    this.providers = [...providers];
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Provider names currently in cooldown (for diagnostics / health UI). */
  coolingDown(): string[] {
    const t = this.now();
    return this.providers
      .filter((p) => (this.state.get(p.name)?.cooldownUntil ?? 0) > t)
      .map((p) => p.name);
  }

  async route(messages: ChatMessage[], opts: ChatOptions = {}): Promise<RouteOutcome> {
    const attempts: AttemptRecord[] = [];
    for (const provider of this.providers) {
      const st = this.state.get(provider.name) ?? { failures: 0, cooldownUntil: 0 };
      if (st.cooldownUntil > this.now()) {
        attempts.push({ provider: provider.name, ok: false, error: 'in cooldown, skipped' });
        continue;
      }
      const keyAttempts = isKeyRotating(provider) ? Math.max(1, provider.keyCount) : 1;
      let answered: ChatResult | undefined;
      let lastError: unknown;
      for (let i = 0; i < keyAttempts; i++) {
        const keyIndex = isKeyRotating(provider) ? provider.keyIndex : undefined;
        try {
          answered = await provider.chat(messages, opts);
          attempts.push({ provider: provider.name, keyIndex, ok: true });
          break;
        } catch (err) {
          lastError = err;
          attempts.push({
            provider: provider.name,
            keyIndex,
            ok: false,
            status: err instanceof ProviderError ? err.status : undefined,
            error: err instanceof Error ? err.message : String(err),
          });
          if (!isRetryableError(err)) throw err;
          if (isKeyRotating(provider)) provider.rotateKey();
        }
      }
      if (answered) {
        this.state.set(provider.name, { failures: 0, cooldownUntil: 0 });
        return { result: answered, provider: provider.name, attempts };
      }
      const failures = st.failures + 1;
      this.state.set(provider.name, {
        failures,
        cooldownUntil: this.now() + this.cooldownMs * failures,
      });
      void lastError;
    }
    throw new AllProvidersFailedError(attempts);
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const { result } = await this.route(messages, opts);
    return result;
  }
}
