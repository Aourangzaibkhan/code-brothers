import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { catalogStore, type SkuMapping } from '../stores/localStores';
import { Button, ErrorBanner, Field, Input, PageHeader } from '../components/ui';

type Draft = Omit<SkuMapping, 'id' | 'updatedAt'> & { id?: string };

const emptyDraft: Draft = {
  masterSku: '', productName: '', shopifySku: '', darazSku: '', localSku: '',
  stock: 0, price: 0, currency: 'PKR',
};

/**
 * Master SKU Mapper (spec §7): one master SKU linked across Shopify, Daraz
 * and the local store. Backed by catalogStore, which calls the real
 * /api/catalog endpoints. The API has no product-name field, so the product
 * input is a local label only and is not required.
 */
export function CatalogPage() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<SkuMapping[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await catalogStore.listMappings());
    } catch {
      setError(t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await catalogStore.upsertMapping({
        ...draft,
        shopifySku: draft.shopifySku || undefined,
        darazSku: draft.darazSku || undefined,
        localSku: draft.localSku || undefined,
      });
      setDraft(emptyDraft);
      await load();
    } catch {
      setError(t('common.error'));
    }
  };

  const edit = (row: SkuMapping) => {
    setDraft({
      id: row.id, masterSku: row.masterSku, productName: row.productName,
      shopifySku: row.shopifySku ?? '', darazSku: row.darazSku ?? '', localSku: row.localSku ?? '',
      stock: row.stock, price: row.price, currency: row.currency,
    });
  };

  const remove = async (id: string) => {
    await catalogStore.deleteMapping(id);
    await load();
  };

  return (
    <div>
      <PageHeader title={t('catalog.title')} />
      <ErrorBanner message={error} />

      <form onSubmit={submit} className="mb-6 grid max-w-4xl grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-white p-4 lg:grid-cols-4">
        <Field label={t('catalog.masterSku')}>
          <Input required value={draft.masterSku} onChange={(e) => setDraft({ ...draft, masterSku: e.target.value })} aria-label={t('catalog.masterSku')} />
        </Field>
        <Field label={t('catalog.product')}>
          <Input value={draft.productName} onChange={(e) => setDraft({ ...draft, productName: e.target.value })} aria-label={t('catalog.product')} />
        </Field>
        <Field label={t('catalog.shopifySku')}>
          <Input value={draft.shopifySku} onChange={(e) => setDraft({ ...draft, shopifySku: e.target.value })} aria-label={t('catalog.shopifySku')} />
        </Field>
        <Field label={t('catalog.darazSku')}>
          <Input value={draft.darazSku} onChange={(e) => setDraft({ ...draft, darazSku: e.target.value })} aria-label={t('catalog.darazSku')} />
        </Field>
        <Field label={t('catalog.localSku')}>
          <Input value={draft.localSku} onChange={(e) => setDraft({ ...draft, localSku: e.target.value })} aria-label={t('catalog.localSku')} />
        </Field>
        <Field label={t('catalog.stock')}>
          <Input type="number" value={draft.stock} onChange={(e) => setDraft({ ...draft, stock: Number(e.target.value) })} aria-label={t('catalog.stock')} />
        </Field>
        <Field label={t('catalog.price')}>
          <Input type="number" value={draft.price} onChange={(e) => setDraft({ ...draft, price: Number(e.target.value) })} aria-label={t('catalog.price')} />
        </Field>
        <Field label="Currency">
          <Input value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} aria-label="Currency" />
        </Field>
        <div className="col-span-2 flex gap-2 lg:col-span-4">
          <Button type="submit">{draft.id ? t('catalog.save') : t('catalog.add')}</Button>
          {draft.id ? (
            <Button type="button" variant="secondary" onClick={() => setDraft(emptyDraft)}>
              {t('common.cancel')}
            </Button>
          ) : null}
        </div>
      </form>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t('catalog.empty')}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 text-start">{t('catalog.masterSku')}</th>
                <th className="px-3 py-2 text-start">{t('catalog.product')}</th>
                <th className="px-3 py-2 text-start">{t('catalog.shopifySku')}</th>
                <th className="px-3 py-2 text-start">{t('catalog.darazSku')}</th>
                <th className="px-3 py-2 text-start">{t('catalog.localSku')}</th>
                <th className="px-3 py-2 text-start">{t('catalog.stock')}</th>
                <th className="px-3 py-2 text-start">{t('catalog.price')}</th>
                <th className="px-3 py-2 text-start">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-medium">{row.masterSku}</td>
                  <td className="px-3 py-2">{row.productName}</td>
                  <td className="px-3 py-2">{row.shopifySku ?? '—'}</td>
                  <td className="px-3 py-2">{row.darazSku ?? '—'}</td>
                  <td className="px-3 py-2">{row.localSku ?? '—'}</td>
                  <td className="px-3 py-2">{row.stock}</td>
                  <td className="px-3 py-2">{row.currency} {row.price}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <Button variant="ghost" onClick={() => edit(row)}>{t('common.edit')}</Button>
                      <Button variant="ghost" onClick={() => void remove(row.id)}>{t('common.delete')}</Button>
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
