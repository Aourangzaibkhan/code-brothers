import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import type { AuditLogEntry, HealthScore, PublicUser, SessionInfo } from '../api/types';
import { Button, ErrorBanner, Field, Input, PageHeader, StatusPill } from '../components/ui';

/**
 * Security Center (spec §8H): live health score, TOTP 2FA management, active
 * session/device manager, immutable audit log viewer, and the 1-click
 * emergency kill switch — all wired to /api/security/* and /api/auth/*.
 */
export function SecurityPage({ user, onUserChange }: { user: PublicUser; onUserChange: (u: PublicUser) => void }) {
  const { t } = useTranslation();
  const [health, setHealth] = useState<HealthScore | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [enrolSecret, setEnrolSecret] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const load = useCallback(async () => {
    try {
      const [h, s, l] = await Promise.all([
        api.healthScore(),
        api.listSessions(),
        api.listAuditLogs({ limit: 100 }).catch(() => [] as AuditLogEntry[]),
      ]);
      setHealth(h);
      setSessions(s);
      setLogs(l);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const fail = (err: unknown) =>
    setError(err instanceof ApiError ? err.message || err.code : t('common.error'));

  const enrol = async () => {
    try {
      setEnrolSecret(await api.totpEnrol());
      setError(null);
    } catch (err) {
      fail(err);
    }
  };

  const confirmTotp = async () => {
    try {
      await api.totpConfirm(totpCode.trim());
      setEnrolSecret(null);
      setTotpCode('');
      onUserChange(await api.me());
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const disableTotp = async () => {
    try {
      await api.totpDisable(disableCode.trim());
      setDisableCode('');
      onUserChange(await api.me());
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const revoke = async (session: SessionInfo) => {
    try {
      await api.revokeSession(session.id);
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const kill = async () => {
    if (!window.confirm(t('security.killConfirm'))) return;
    try {
      const res = await api.killSwitch();
      setHealth((prev) => (prev ? { ...prev, halted: res.halted } : prev));
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const resume = async () => {
    try {
      const res = await api.resumePlatform();
      setHealth((prev) => (prev ? { ...prev, halted: res.halted } : prev));
      setNotice(t('security.resumed'));
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const scoreColor = health && health.score >= 75 ? 'text-green-600' : health && health.score >= 50 ? 'text-amber-600' : 'text-red-600';

  return (
    <div>
      <PageHeader title={t('security.title')}>
        <Button variant="secondary" onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
      </PageHeader>
      <ErrorBanner message={error} />
      {notice ? <div className="mb-2 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div> : null}
      {health?.halted ? (
        <div className="mb-4 flex items-center justify-between rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          <span>{t('security.haltedBanner')}</span>
          <Button variant="danger" onClick={() => void resume()}>
            {t('security.resume')}
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Health score */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold">{t('security.healthScore')}</h2>
          {health ? (
            <>
              <div className={`text-4xl font-bold ${scoreColor}`}>
                {health.score}
                <span className="text-base text-slate-400"> / {health.maxScore}</span>
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {health.factors.map((factor) => (
                  <li key={factor.key} className="flex items-center justify-between gap-2">
                    <span>{factor.label}</span>
                    <span className={factor.passed ? 'text-green-600' : 'text-red-600'}>
                      {factor.passed ? '✓' : '✕'} {factor.weight}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-slate-400">
                {t('security.computedAt')}: {new Date(health.computedAt).toLocaleString()}
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-500">{t('common.loading')}</p>
          )}
          <div className="mt-4 border-t border-slate-100 pt-3">
            {health?.halted ? (
              <Button variant="secondary" onClick={() => void resume()}>
                {t('security.resume')}
              </Button>
            ) : (
              <Button variant="danger" onClick={() => void kill()}>
                {t('security.killSwitch')}
              </Button>
            )}
          </div>
        </section>

        {/* 2FA */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold">{t('security.twoFactor')}</h2>
          <p className="text-sm">
            {user.totpEnabled ? (
              <span className="text-green-600">✓ {t('security.enabled')}</span>
            ) : (
              <span className="text-amber-600">{t('security.disabled')}</span>
            )}
          </p>
          {!user.totpEnabled ? (
            <div className="mt-3 space-y-3">
              {!enrolSecret ? (
                <Button onClick={() => void enrol()}>{t('security.enrol')}</Button>
              ) : (
                <>
                  <p className="text-sm text-slate-600">{t('security.enrolHint')}</p>
                  <div className="text-sm">
                    {t('security.secret')}: <code className="rounded bg-slate-100 px-2 py-0.5">{enrolSecret.secret}</code>
                  </div>
                  <code className="block break-all rounded bg-slate-50 p-2 text-xs">{enrolSecret.otpauthUri}</code>
                  <div className="flex max-w-xs gap-2">
                    <Field label={t('security.code')}>
                      <Input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} aria-label={t('security.code')} inputMode="numeric" />
                    </Field>
                  </div>
                  <Button onClick={() => void confirmTotp()}>{t('security.confirm')}</Button>
                </>
              )}
            </div>
          ) : (
            <div className="mt-3 flex max-w-xs items-end gap-2">
              <Field label={t('security.code')}>
                <Input value={disableCode} onChange={(e) => setDisableCode(e.target.value)} aria-label={t('security.code')} inputMode="numeric" />
              </Field>
              <Button variant="danger" onClick={() => void disableTotp()}>
                {t('security.disable')}
              </Button>
            </div>
          )}
        </section>

        {/* Sessions */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold">{t('security.sessions')}</h2>
          <ul className="space-y-2 text-sm">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
                <div>
                  <div className="font-medium">
                    {session.deviceName ?? session.userAgent ?? session.id.slice(0, 8)}
                    {session.current ? <span className="ms-2 text-xs text-green-600">{t('security.currentSession')}</span> : null}
                  </div>
                  <div className="text-xs text-slate-400">
                    {t('security.ip')}: {session.ipAddress ?? '—'} · {t('security.expires')}:{' '}
                    {new Date(session.expiresAt).toLocaleString()}
                    {session.revokedAt ? ` · ${t('security.sessions')}: revoked` : ''}
                    {session.expired ? ' · expired' : ''}
                  </div>
                </div>
                {!session.revokedAt && !session.current ? (
                  <Button variant="ghost" onClick={() => void revoke(session)}>
                    {t('security.revoke')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        {/* Audit logs */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold">{t('security.auditLogs')}</h2>
          {logs.length === 0 ? (
            <p className="text-sm text-slate-500">—</p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 text-start">{t('security.time')}</th>
                    <th className="py-1 text-start">{t('security.eventType')}</th>
                    <th className="py-1 text-start">{t('security.severity')}</th>
                    <th className="py-1 text-start">{t('security.ip')}</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-t border-slate-100">
                      <td className="py-1 pe-2">{new Date(log.createdAt).toLocaleString()}</td>
                      <td className="py-1 pe-2 font-medium">{log.eventType}</td>
                      <td className="py-1 pe-2"><StatusPill status={log.severity} /></td>
                      <td className="py-1">{log.ipAddress ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
