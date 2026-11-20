import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { PublicUser, SetupStatus } from '../api/types';

export type AuthPhase =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'login' }
  | { kind: 'ready'; user: PublicUser };

interface AuthContextValue {
  phase: AuthPhase;
  refresh: () => Promise<void>;
  setUser: (user: PublicUser) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const status: SetupStatus = await api.setupStatus();
      if (status.setupRequired) {
        setPhase({ kind: 'setup' });
        return;
      }
    } catch {
      /* API unreachable — fall through to login/ready detection */
    }
    if (!api.hasToken) {
      setPhase({ kind: 'login' });
      return;
    }
    try {
      const user = await api.me();
      setPhase({ kind: 'ready', user });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) api.setToken(null);
      setPhase({ kind: 'login' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setUser = useCallback((user: PublicUser) => setPhase({ kind: 'ready', user }), []);

  const signOut = useCallback(async () => {
    await api.logout();
    setPhase({ kind: 'login' });
  }, []);

  const value = useMemo(
    () => ({ phase, refresh, setUser, signOut }),
    [phase, refresh, setUser, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
