import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, ErrorBanner, Field, Input } from '../components/ui';
import { CenteredCard } from './SetupPage';

/** Login screen; the TOTP field appears when the API answers `totp_required`. */
export function LoginPage() {
  const { t } = useTranslation();
  const { setUser } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(email.trim(), password, totpRequired ? totpCode.trim() : undefined);
      setUser(result.user);
    } catch (err) {
      if (err instanceof ApiError && err.totpRequired) {
        setTotpRequired(true);
        setError(null);
      } else if (err instanceof ApiError && err.code === 'invalid_totp_code') {
        setError(err.code);
      } else if (err instanceof ApiError && err.status === 401) {
        setError(t('auth.invalidCredentials'));
      } else {
        setError(err instanceof Error ? err.message : t('common.error'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <CenteredCard>
      <h1 className="text-lg font-bold">{t('auth.loginTitle')}</h1>
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <Field label={t('auth.email')}>
          <Input
            required type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="email" aria-label={t('auth.email')}
          />
        </Field>
        <Field label={t('auth.password')}>
          <Input
            required type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" aria-label={t('auth.password')}
          />
        </Field>
        {totpRequired ? (
          <Field label={t('auth.totpCode')} hint={t('auth.totpHint')}>
            <Input
              value={totpCode} onChange={(e) => setTotpCode(e.target.value)}
              autoComplete="one-time-code" inputMode="numeric" aria-label={t('auth.totpCode')}
              autoFocus
            />
          </Field>
        ) : null}
        <ErrorBanner message={error} />
        <Button className="w-full" type="submit" disabled={busy}>
          {t('auth.login')}
        </Button>
      </form>
    </CenteredCard>
  );
}
