import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import type { Workflow } from '../api/types';
import { Button, ErrorBanner, PageHeader, StatusPill } from '../components/ui';

export function WorkflowsPage({
  onOpen,
  onNew,
}: {
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setWorkflows(await api.listWorkflows());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (workflow: Workflow) => {
    if (!window.confirm(t('workflows.deleteConfirm'))) return;
    try {
      await api.deleteWorkflow(workflow.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    }
  };

  const run = async (workflow: Workflow) => {
    try {
      await api.runWorkflow(workflow.id);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    }
  };

  return (
    <div>
      <PageHeader title={t('workflows.title')}>
        <Button variant="secondary" onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
        <Button onClick={onNew}>{t('workflows.new')}</Button>
      </PageHeader>
      <ErrorBanner message={error} />
      {loading ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : workflows.length === 0 ? (
        <p className="text-sm text-slate-500">{t('workflows.empty')}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-start text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 text-start">{t('common.name')}</th>
                <th className="px-3 py-2 text-start">{t('common.status')}</th>
                <th className="px-3 py-2 text-start">{t('common.version')}</th>
                <th className="px-3 py-2 text-start">{t('common.updatedAt')}</th>
                <th className="px-3 py-2 text-start">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((workflow) => (
                <tr key={workflow.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <div className="font-medium">{workflow.name}</div>
                    <div className="text-xs text-slate-400">
                      {workflow.nodes.length} {t('workflows.nodes')}
                      {workflow.description ? ` · ${workflow.description}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={workflow.isActive ? 'active' : 'inactive'} />
                  </td>
                  <td className="px-3 py-2">{workflow.currentVersion}</td>
                  <td className="px-3 py-2 text-slate-500">
                    {new Date(workflow.updatedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <Button variant="secondary" onClick={() => onOpen(workflow.id)}>
                        {t('workflows.open')}
                      </Button>
                      <Button variant="ghost" onClick={() => void run(workflow)}>
                        {t('workflows.run')}
                      </Button>
                      <Button variant="ghost" onClick={() => void remove(workflow)}>
                        {t('common.delete')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
