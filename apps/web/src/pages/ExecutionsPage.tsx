import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import type { Execution } from '../api/types';
import { Button, ErrorBanner, PageHeader, Select, StatusPill } from '../components/ui';

/** Executions inspector (spec §5): run history + per-step detail. */
export function ExecutionsPage() {
  const { t } = useTranslation();
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [workflowFilter, setWorkflowFilter] = useState('');
  const [selected, setSelected] = useState<Execution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [execs, wfs] = await Promise.all([
        api.listExecutions(workflowFilter ? { workflowId: workflowFilter } : undefined),
        api.listWorkflows(),
      ]);
      setExecutions(execs);
      setWorkflows(wfs.map((w) => ({ id: w.id, name: w.name })));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t, workflowFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (id: string) => {
    try {
      setSelected(await api.getExecution(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    }
  };

  return (
    <div>
      <PageHeader title={t('executions.title')}>
        <div className="w-56">
          <Select
            value={workflowFilter}
            onChange={(e) => setWorkflowFilter(e.target.value)}
            aria-label={t('executions.workflow')}
          >
            <option value="">{t('executions.allWorkflows')}</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </Select>
        </div>
        <Button variant="secondary" onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
      </PageHeader>
      <ErrorBanner message={error} />

      <div className="flex gap-4">
        <div className="flex-1 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {loading ? (
            <p className="p-3 text-sm text-slate-500">{t('common.loading')}</p>
          ) : executions.length === 0 ? (
            <p className="p-3 text-sm text-slate-500">{t('executions.empty')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-start">{t('executions.workflow')}</th>
                  <th className="px-3 py-2 text-start">{t('common.status')}</th>
                  <th className="px-3 py-2 text-start">{t('executions.trigger')}</th>
                  <th className="px-3 py-2 text-start">{t('executions.started')}</th>
                  <th className="px-3 py-2 text-start">{t('executions.duration')}</th>
                  <th className="px-3 py-2 text-start">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((execution) => (
                  <tr key={execution.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium">{execution.workflowName ?? execution.workflowId}</td>
                    <td className="px-3 py-2"><StatusPill status={execution.status} /></td>
                    <td className="px-3 py-2">{execution.triggerType}</td>
                    <td className="px-3 py-2 text-slate-500">{new Date(execution.startedAt).toLocaleString()}</td>
                    <td className="px-3 py-2">{execution.durationMs} ms</td>
                    <td className="px-3 py-2">
                      <Button variant="ghost" onClick={() => void openDetail(execution.id)}>
                        {t('executions.viewDetail')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selected ? (
          <div className="w-96 shrink-0 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3" style={{ maxHeight: '75vh' }}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{selected.workflowName ?? selected.id}</h2>
              <StatusPill status={selected.status} />
            </div>
            {selected.error ? <ErrorBanner message={selected.error} /> : null}
            <h3 className="mb-1 mt-2 text-xs font-semibold uppercase text-slate-500">{t('executions.steps')}</h3>
            <div className="space-y-2">
              {selected.steps.map((step) => (
                <details key={step.nodeId} className="rounded border border-slate-200 p-2 text-sm">
                  <summary className="flex cursor-pointer items-center justify-between">
                    <span>
                      {step.nodeName} <span className="text-xs text-slate-400">({step.nodeType})</span>
                    </span>
                    <StatusPill status={step.status} />
                  </summary>
                  <div className="mt-2 space-y-1 text-xs text-slate-600">
                    <div>{t('executions.duration')}: {step.durationMs} ms · {t('executions.attempts')}: {step.attempts}</div>
                    {step.error ? <div className="text-red-600">{step.error}</div> : null}
                    <div className="font-semibold text-slate-500">{t('executions.stepInput')}</div>
                    <pre className="max-h-32 overflow-auto rounded bg-slate-50 p-2">{JSON.stringify(step.input, null, 2)}</pre>
                    <div className="font-semibold text-slate-500">{t('executions.stepOutput')}</div>
                    <pre className="max-h-32 overflow-auto rounded bg-slate-50 p-2">{JSON.stringify(step.output, null, 2)}</pre>
                  </div>
                </details>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
