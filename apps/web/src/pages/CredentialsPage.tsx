import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import type { CredentialMeta } from '../api/types';
import { Button, ErrorBanner, Field, Input, PageHeader, Select } from '../components/ui';

const PROVIDERS = ['whatsappCloud', 'instagramGraph', 'youtubeOAuth', 'shopify', 'daraz', 'localStore', 'smtp', 'googleSheets', 'courierApi', 'custom'];
const KINDS: CredentialMeta['kind'][] = ['api_key', 'oauth', 'basic', 'custom'];

/**
 * Credentials Vault (spec §8C): write-only. The API returns metadata only —
 * secret values go in and never come back out.
 */
export function CredentialsPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<CredentialMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('custom');
  const [kind, setKind] = useState<CredentialMeta['kind']>('api_key');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await api.listCredentials());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createCredential({ name: name.trim(), provider, kind, value });
      setName('');
      setValue('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (cred: CredentialMeta) => {
    if (!window.confirm(t('credentials.deleteConfirm'))) return;
    try {
      await api.deleteCredential(cred.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    }
  };

  return (
    <div>
      <PageHeader title={t('credentials.title')} />
      <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        {t('credentials.writeOnly')}
      </div>
      <ErrorBanner message={error} />

      <form onSubmit={submit} className="mb-6 grid max-w-3xl grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <Field label={t('common.name')} hint={t('credentials.nameHint')}>
          <Input required value={name} onChange={(e) => setName(e.target.value)} aria-label={t('common.name')} />
        </Field>
        <Field label={t('credentials.provider')}>
          <Select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label={t('credentials.provider')}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </Select>
        </Field>
        <Field label={t('credentials.kind')}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as CredentialMeta['kind'])} aria-label={t('credentials.kind')}>
            {KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </Select>
        </Field>
        <Field label={t('credentials.value')}>
          <Input
            required type="password" value={value} onChange={(e) => setValue(e.target.value)}
            aria-label={t('credentials.value')} autoComplete="off"
          />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy}>{t('credentials.add')}</Button>
        </div>
      </form>

      {items.length === 0 ? (
        <p className="text-sm text-slate-500">{t('credentials.empty')}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 text-start">{t('common.name')}</th>
                <th className="px-3 py-2 text-start">{t('credentials.provider')}</th>
                <th className="px-3 py-2 text-start">{t('credentials.kind')}</th>
                <th className="px-3 py-2 text-start">{t('common.createdAt')}</th>
                <th className="px-3 py-2 text-start">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((cred) => (
                <tr key={cred.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-medium">{cred.name}</td>
                  <td className="px-3 py-2">{cred.provider}</td>
                  <td className="px-3 py-2">{cred.kind}</td>
                  <td className="px-3 py-2 text-slate-500">{new Date(cred.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <Button variant="ghost" onClick={() => void remove(cred)}>
                      {t('common.delete')}
                    </Button>
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
