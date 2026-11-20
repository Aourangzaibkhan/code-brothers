import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { calendarStore, type CalendarItem } from '../stores/localStores';
import { Button, ErrorBanner, Field, Input, PageHeader, Select, StatusPill } from '../components/ui';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Content Calendar (spec §7/§9): month view of scheduled YouTube/Instagram
 * content. Backed by calendarStore (no API route exists yet).
 */
export function CalendarPage() {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [title, setTitle] = useState('');
  const [channel, setChannel] = useState<CalendarItem['channel']>('youtube');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await calendarStore.listItems());
    } catch {
      setError(t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const cells = useMemo(() => {
    const first = new Date(cursor.year, cursor.month, 1);
    // Monday-first offset
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
    const list: Array<{ date: string; day: number } | null> = [];
    for (let i = 0; i < offset; i++) list.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      list.push({ date: iso, day: d });
    }
    return list;
  }, [cursor]);

  const itemsByDate = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of items) {
      const list = map.get(item.date) ?? [];
      list.push(item);
      map.set(item.date, list);
    }
    return map;
  }, [items]);

  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString(i18n.language, {
    month: 'long',
    year: 'numeric',
  });

  const move = (delta: number) => {
    setCursor((prev) => {
      const next = new Date(prev.year, prev.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!date) return;
    try {
      await calendarStore.createItem({ title: title.trim(), channel, date, status: 'scheduled' });
      setTitle('');
      await load();
    } catch {
      setError(t('common.error'));
    }
  };

  const remove = async (id: string) => {
    await calendarStore.deleteItem(id);
    await load();
  };

  return (
    <div>
      <PageHeader title={t('calendar.title')}>
        <Button variant="secondary" onClick={() => move(-1)}>{t('calendar.prev')}</Button>
        <span className="min-w-40 text-center font-semibold">{monthLabel}</span>
        <Button variant="secondary" onClick={() => move(1)}>{t('calendar.next')}</Button>
      </PageHeader>
      <ErrorBanner message={error} />

      <form onSubmit={submit} className="mb-4 flex max-w-3xl flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div className="min-w-48 flex-1">
          <Field label={t('calendar.itemTitle')}>
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('calendar.itemTitle')} />
          </Field>
        </div>
        <div className="w-40">
          <Field label={t('calendar.channel')}>
            <Select value={channel} onChange={(e) => setChannel(e.target.value as CalendarItem['channel'])} aria-label={t('calendar.channel')}>
              <option value="youtube">YouTube</option>
              <option value="instagram">Instagram</option>
              <option value="facebook">Facebook</option>
            </Select>
          </Field>
        </div>
        <div className="w-44">
          <Field label={t('calendar.date')}>
            <Input required type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t('calendar.date')} />
          </Field>
        </div>
        <Button type="submit">{t('calendar.add')}</Button>
      </form>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="grid grid-cols-7 bg-slate-50 text-center text-xs font-semibold uppercase text-slate-500">
          {WEEKDAYS.map((d) => (
            <div key={d} className="py-2">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((cell, i) => (
            <div key={i} className="min-h-24 border-t border-slate-100 p-1.5">
              {cell ? (
                <>
                  <div className="text-xs font-medium text-slate-500">{cell.day}</div>
                  <div className="mt-1 space-y-1">
                    {(itemsByDate.get(cell.date) ?? []).map((item) => (
                      <div key={item.id} className="group rounded bg-brand-50 px-1.5 py-1 text-[11px] leading-tight">
                        <div className="font-medium text-slate-800">{item.title}</div>
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-slate-400">{item.channel}</span>
                          <StatusPill status={item.status} />
                          <button
                            type="button"
                            aria-label={t('common.delete')}
                            className="text-red-500 opacity-0 group-hover:opacity-100"
                            onClick={() => void remove(item.id)}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      {items.length === 0 ? <p className="mt-3 text-sm text-slate-500">{t('calendar.empty')}</p> : null}
    </div>
  );
}
