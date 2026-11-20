import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, ErrorBanner, Field, Input, LanguageSwitcher } from '../components/ui';
import type { ClaimResult } from '../api/types';

/** First-boot claim screen (spec §8A): one-time setup token -> owner account. */
export function SetupPage() {
  const { t } = useTranslation();
  const { setUser } = useAuth();
  const [setupToken, setSetupToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [enableTotp, setEnableTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [claimed, setClaimed] = useState<ClaimResult | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.claim({
        setupToken: setupToken.trim(),
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
        enableTotp,
      });
      api.setToken(result.token);
      if (result.totpSecret) {
        // Show the one-time TOTP secret before entering the app.
        setClaimed(result);
      } else {
        setUser(result.user);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message || err.code : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  if (claimed) {
    return (
      <CenteredCard>
        <h1 className="text-lg font-bold">{t('auth.totpSecretTitle')}</h1>
        <p className="mt-2 text-sm text-slate-600">{t('auth.totpSecretHint')}</p>
        <code className="mt-3 block break-all rounded bg-slate-100 p-3 text-sm">{claimed.totpSecret}</code>
        {claimed.otpauthUri ? (
          <code className="mt-2 block break-all rounded bg-slate-100 p-3 text-xs">{claimed.otpauthUri}</code>
        ) : null}
        <Button className="mt-4 w-full" onClick={() => setUser(claimed.user)}>
          {t('auth.continue')}
        </Button>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <h1 className="text-lg font-bold">{t('auth.setupTitle')}</h1>
      <p className="mt-1 text-sm text-slate-600">{t('auth.setupHint')}</p>
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <Field label={t('auth.setupToken')}>
          <Input required value={setupToken} onChange={(e) => setSetupToken(e.target.value)} autoComplete="off" />
        </Field>
        <Field label={t('auth.email')}>
          <Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </Field>
        <Field label={t('auth.password')} hint={t('auth.passwordHint')}>
          <Input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label={t('auth.displayName')}>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enableTotp} onChange={(e) => setEnableTotp(e.target.checked)} />
          {t('auth.enableTotp')}
        </label>
        <ErrorBanner message={error} />
        <Button className="w-full" type="submit" disabled={busy}>
          {t('auth.claim')}
        </Button>
      </form>
    </CenteredCard>
  );
}

export function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-base font-bold text-brand-700">Code Brothers</span>
          <LanguageSwitcher />
        </div>
        {children}
      </div>
    </div>
  );
}
