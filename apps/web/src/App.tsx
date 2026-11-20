import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { CopilotDrawer } from './ai-assistant/CopilotDrawer';
import { CanvasPage } from './canvas/CanvasPage';
import { copilotBus } from './canvas/copilotBus';
import { Button, LanguageSwitcher } from './components/ui';
import { CalendarPage } from './calendar/CalendarPage';
import { CatalogPage } from './catalog/CatalogPage';
import { InboxPage } from './inbox/InboxPage';
import { CredentialsPage } from './pages/CredentialsPage';
import { ExecutionsPage } from './pages/ExecutionsPage';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { SecurityPage } from './security/SecurityPage';
import './i18n';

export type View =
  | 'workflows'
  | 'editor'
  | 'executions'
  | 'credentials'
  | 'inbox'
  | 'catalog'
  | 'calendar'
  | 'security';

const NAV: Array<{ view: View; labelKey: string; icon: string }> = [
  { view: 'workflows', labelKey: 'nav.workflows', icon: '▦' },
  { view: 'editor', labelKey: 'nav.editor', icon: '✎' },
  { view: 'executions', labelKey: 'nav.executions', icon: '▶' },
  { view: 'credentials', labelKey: 'nav.credentials', icon: '🔑' },
  { view: 'inbox', labelKey: 'nav.inbox', icon: '✉' },
  { view: 'catalog', labelKey: 'nav.catalog', icon: '▤' },
  { view: 'calendar', labelKey: 'nav.calendar', icon: '📅' },
  { view: 'security', labelKey: 'nav.security', icon: '🛡' },
];

function Shell() {
  const { t } = useTranslation();
  const { phase, signOut, setUser } = useAuth();
  const [view, setView] = useState<View>('workflows');
  const [editorWorkflowId, setEditorWorkflowId] = useState<string | undefined>(undefined);
  const [editorKey, setEditorKey] = useState(0);
  const [copilotOpen, setCopilotOpen] = useState(false);

  // When the Copilot publishes a generated graph, jump to the editor.
  useEffect(
    () =>
      copilotBus.subscribe(() => {
        setEditorWorkflowId(undefined);
        setView('editor');
      }),
    [],
  );

  if (phase.kind === 'loading') {
    return <div className="flex min-h-full items-center justify-center text-slate-500">{t('common.loading')}</div>;
  }
  if (phase.kind === 'setup') return <SetupPage />;
  if (phase.kind === 'login') return <LoginPage />;

  const user = phase.user;

  const openEditor = (id?: string) => {
    setEditorWorkflowId(id);
    setEditorKey((k) => k + 1);
    setView('editor');
  };

  return (
    <div className="flex min-h-full">
      {/* Sidebar — logical properties (border-e, ps/pe) mirror it under RTL */}
      <aside className="flex w-60 shrink-0 flex-col border-e border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-4">
          <div className="text-lg font-bold text-brand-700">{t('app.name')}</div>
          <div className="text-xs text-slate-400">{t('app.tagline')}</div>
        </div>
        <nav className="flex-1 space-y-1 px-2 py-3" aria-label="Main">
          {NAV.map((item) => (
            <button
              key={item.view}
              type="button"
              onClick={() => (item.view === 'editor' ? openEditor(editorWorkflowId) : setView(item.view))}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm font-medium ${
                view === item.view ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <span aria-hidden>{item.icon}</span>
              {t(item.labelKey)}
            </button>
          ))}
        </nav>
        <div className="space-y-3 border-t border-slate-100 px-4 py-3">
          <LanguageSwitcher />
          <div className="text-xs text-slate-400">
            {user.displayName ?? user.email} · {user.role}
          </div>
          <Button variant="ghost" className="w-full justify-start px-0" onClick={() => void signOut()}>
            {t('nav.logout')}
          </Button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-5">
        {view === 'workflows' && (
          <WorkflowsPage onOpen={(id) => openEditor(id)} onNew={() => openEditor(undefined)} />
        )}
        {view === 'editor' && (
          <CanvasPage
            key={editorKey}
            workflowId={editorWorkflowId}
            onOpenWorkflow={(id) => setEditorWorkflowId(id)}
          />
        )}
        {view === 'executions' && <ExecutionsPage />}
        {view === 'credentials' && <CredentialsPage />}
        {view === 'inbox' && <InboxPage />}
        {view === 'catalog' && <CatalogPage />}
        {view === 'calendar' && <CalendarPage />}
        {view === 'security' && <SecurityPage user={user} onUserChange={setUser} />}
      </main>

      <button
        type="button"
        onClick={() => setCopilotOpen(true)}
        className="fixed bottom-5 end-5 z-30 rounded-full bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-brand-700"
      >
        🤖 {t('nav.assistant')}
      </button>
      <CopilotDrawer open={copilotOpen} onClose={() => setCopilotOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
