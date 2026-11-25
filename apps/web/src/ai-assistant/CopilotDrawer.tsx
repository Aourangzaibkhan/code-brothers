import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui';
import { api, ApiError } from '../api/client';
import type { AssistantStatus } from '../api/types';
import { diagnoseError, generateWorkflowFromPrompt, type GeneratedWorkflow } from '../canvas/copilot';
import { copilotBus } from '../canvas/copilotBus';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  graph?: GeneratedWorkflow;
}

/**
 * AI Assistant drawer (spec §4A).
 *
 * Answers come from the real model through POST /api/ai/chat (HybridRouter:
 * Ollama, then Gemini / Groq / OpenRouter). When no AI provider is
 * configured the API answers 503 and the drawer falls back to the local
 * Copilot (see ../canvas/copilot.ts) — a rule-based workflow-graph
 * generator, NOT an AI — and says so in the reply instead of pretending
 * the local answer came from a model.
 */
export function CopilotDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', text: t('copilot.greeting') },
  ]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .assistantStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open ]);

  if (!open) return null;

  const scrollDown = () => {
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    });
  };

  /** Local (non-AI) reply: the rule-based workflow-graph generator. */
  const localReply = (prompt: string): ChatMessage => {
    const diagnosis = diagnoseError(prompt);
    if (diagnosis) return { role: 'assistant', text: diagnosis };
    const graph = generateWorkflowFromPrompt(prompt);
    if (graph) return { role: 'assistant', text: t('copilot.generated'), graph };
    return { role: 'assistant', text: t('copilot.noMatch') };
  };

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || busy) return;
    setDraft('');
    const history = [...messages, { role: 'user' as const, text: prompt }];
    setMessages(history);
    scrollDown();

    // Error-diagnosis prompts are answered locally on purpose (the
    // diagnostician reads the prompt, it is not a model call).
    const diagnosis = diagnoseError(prompt);
    if (diagnosis) {
      setMessages((prev) => [...prev, { role: 'assistant', text: diagnosis }]);
      scrollDown();
      return;
    }

    setBusy(true);
    try {
      const result = await api.assistantChat(
        history.map((m) => ({ role: m.role, content: m.text })),
      );
      // Attach the locally generated graph when the prompt maps to one —
      // the chat answers, the graph is the actionable artifact.
      const graph = generateWorkflowFromPrompt(prompt);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: result.text,
          ...(graph ? { graph } : {}),
        },
      ]);
    } catch (err) {
      // No provider (503) or every provider failed (502): fall back to the
      // local generator and say so — never present its output as AI.
      const code = err instanceof ApiError ? err.code : 'request_failed';
      const fallback = localReply(prompt);
      setMessages((prev) => [
        ...prev,
        {
          ...fallback,
          text:
            code === 'no_ai_provider_configured'
              ? `${t('copilot.aiNotConfigured')} ${fallback.text}`
              : `${t('copilot.aiUnavailable')} ${fallback.text}`,
        },
      ]);
    } finally {
      setBusy(false);
      scrollDown();
    }
  };

  return (
    <aside
      aria-label={t('copilot.title')}
      className="fixed inset-y-0 end-0 z-40 flex w-full max-w-sm flex-col border-s border-slate-200 bg-white shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="font-semibold">{t('copilot.title')}</h2>
        <Button variant="ghost" onClick={onClose} aria-label={t('common.close')}>
          ✕
        </Button>
      </div>
      <p className="border-b border-slate-100 px-4 py-1.5 text-xs text-slate-500">
        {status === null
          ? t('copilot.aiChecking')
          : status.configured
            ? t('copilot.aiReady', { providers: status.providers.join(', ') })
            : t('copilot.aiNotConfiguredShort')}
      </p>
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                m.role === 'user' ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-800'
              }`}
            >
              <p>{m.text}</p>
              {m.graph ? (
                <div className="mt-2 rounded bg-white/70 p-2 text-xs text-slate-700">
                  <p className="font-semibold">{m.graph.name}</p>
                  <p>
                    {m.graph.nodes.map((node) => node.name ?? node.type).join(' → ')}
                  </p>
                  <Button
                    className="mt-2"
                    onClick={() => {
                      if (m.graph) copilotBus.publish(m.graph);
                      onClose();
                    }}
                  >
                    {t('copilot.insert')}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 border-t border-slate-200 p-3">
        <input
          aria-label={t('copilot.placeholder')}
          className="flex-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
          placeholder={t('copilot.placeholder')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
          }}
          disabled={busy}
        />
        <Button onClick={() => void send()} disabled={busy}>
          {busy ? '…' : t('copilot.send')}
        </Button>
      </div>
    </aside>
  );
}
