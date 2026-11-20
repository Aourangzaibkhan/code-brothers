import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui';
import { diagnoseError, generateWorkflowFromPrompt, type GeneratedWorkflow } from './copilot';
import { copilotBus } from './copilotBus';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  graph?: GeneratedWorkflow;
}

/**
 * AI Assistant drawer (spec §4A). The API exposes no chat endpoint yet, so
 * this runs the local Copilot (see ./copilot.ts): it generates a real,
 * runnable workflow graph from the prompt and inserts it into the canvas.
 */
export function CopilotDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', text: t('copilot.greeting') },
  ]);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  if (!open) return null;

  const send = () => {
    const prompt = draft.trim();
    if (!prompt) return;
    setDraft('');
    const diagnosis = diagnoseError(prompt);
    const graph = diagnosis ? null : generateWorkflowFromPrompt(prompt);
    const reply: ChatMessage = diagnosis
      ? { role: 'assistant', text: diagnosis }
      : graph
        ? { role: 'assistant', text: t('copilot.generated'), graph }
        : { role: 'assistant', text: t('copilot.noMatch') };
    setMessages((prev) => [...prev, { role: 'user', text: prompt }, reply]);
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    });
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
            if (e.key === 'Enter') send();
          }}
        />
        <Button onClick={send}>{t('copilot.send')}</Button>
      </div>
    </aside>
  );
}
