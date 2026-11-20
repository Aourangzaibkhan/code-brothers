import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inboxStore, type Conversation, type Message } from '../stores/localStores';
import { Button, ErrorBanner, Input, PageHeader } from '../components/ui';

/**
 * Unified Inbox (spec §7): WhatsApp + Instagram threads with human takeover.
 * Backed by inboxStore, which calls the real /api/inbox endpoints.
 */
export function InboxPage() {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const convs = await inboxStore.listConversations();
      setConversations(convs);
      setActiveId((prev) => prev ?? convs[0]?.id ?? null);
    } catch {
      setError(t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!activeId) return;
    inboxStore.listMessages(activeId).then(setMessages).catch(() => setError(t('common.error')));
  }, [activeId, t]);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  const togglePause = async () => {
    if (!active) return;
    const updated = await inboxStore.setAiPaused(active.id, !active.aiPaused);
    setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  const send = async () => {
    if (!active || !draft.trim()) return;
    const message = await inboxStore.sendMessage(active.id, draft.trim());
    setMessages((prev) => [...prev, message]);
    setDraft('');
    void loadConversations();
  };

  return (
    <div>
      <PageHeader title={t('inbox.title')} />
      <ErrorBanner message={error} />
      <div className="flex gap-4">
        <div className="w-72 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {conversations.length === 0 ? (
            <p className="p-3 text-sm text-slate-500">{t('inbox.empty')}</p>
          ) : (
            conversations.map((conv) => (
              <button
                key={conv.id}
                type="button"
                onClick={() => setActiveId(conv.id)}
                className={`block w-full border-b border-slate-100 px-3 py-2 text-start hover:bg-slate-50 ${
                  conv.id === activeId ? 'bg-brand-50' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{conv.customerName}</span>
                  {conv.unread > 0 ? (
                    <span className="rounded-full bg-brand-600 px-1.5 text-xs text-white">{conv.unread}</span>
                  ) : null}
                </div>
                <div className="text-xs text-slate-400">
                  {conv.channel} · {conv.customerHandle}
                  {conv.language ? ` · ${conv.language}` : ''}
                  {conv.aiPaused ? ' · ⏸ AI' : ''}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="flex min-h-[60vh] flex-1 flex-col rounded-lg border border-slate-200 bg-white">
          {active ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2">
                <div>
                  <div className="text-sm font-semibold">{active.customerName}</div>
                  <div className="text-xs text-slate-400">{active.channel} · {active.customerHandle}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs ${active.aiPaused ? 'text-amber-600' : 'text-green-600'}`}>
                    {active.aiPaused ? t('inbox.aiPaused') : t('inbox.aiActive')}
                  </span>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={active.aiPaused}
                      onChange={() => void togglePause()}
                      aria-label={t('inbox.pauseAi')}
                    />
                    {t('inbox.pauseAi')}
                  </label>
                </div>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto p-4" style={{ maxHeight: '55vh' }}>
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                        m.direction === 'out' ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-800'
                      }`}
                    >
                      <p>{m.body}</p>
                      <p className={`mt-1 text-[10px] ${m.direction === 'out' ? 'text-white/70' : 'text-slate-400'}`}>
                        {m.author} · {new Date(m.createdAt).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 border-t border-slate-200 p-3">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={t('inbox.placeholder')}
                  aria-label={t('inbox.placeholder')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void send();
                  }}
                />
                <Button onClick={() => void send()}>{t('inbox.send')}</Button>
              </div>
            </>
          ) : (
            <p className="p-4 text-sm text-slate-500">{t('inbox.empty')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
