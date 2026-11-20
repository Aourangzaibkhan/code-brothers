import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../App';
import { api } from '../api/client';
import { mockFetch, testUser } from './mockFetch';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

describe('login flow', () => {
  beforeEach(() => {
    window.localStorage.clear();
    api.setToken(null); // the shared client keeps the token in memory too
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits credentials, stores the session token and enters the shell', async () => {
    const { fn } = mockFetch({
      'GET /api/setup/status': { setupRequired: false, setupClosed: true },
      'POST /api/auth/login': { token: 'tok-123', user: testUser },
      'GET /api/auth/me': { user: testUser },
      'GET /api/workflows': { workflows: [] },
    });
    vi.stubGlobal('fetch', fn);

    render(<App />);

    const email = await screen.findByLabelText('Email');
    const password = screen.getByLabelText('Password');
    fireEvent.change(email, { target: { value: 'owner@example.com' } });
    fireEvent.change(password, { target: { value: 'supersecret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(window.localStorage.getItem('cb.session.token')).toBe('tok-123');
    });
    // The app shell (sidebar navigation) is shown after login.
    expect(await screen.findByRole('button', { name: /Workflows/ })).toBeInTheDocument();
  });

  it('reveals the TOTP field when the API answers totp_required', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/setup/status') return json({ setupRequired: false, setupClosed: true });
      if (url === '/api/auth/login') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { totpCode?: string };
        if (!body.totpCode) return json({ error: 'totp_required', totpRequired: true }, 401);
        return json({ token: 'tok-2fa', user: testUser });
      }
      if (url === '/api/auth/me') return json({ user: testUser });
      if (url === '/api/workflows') return json({ workflows: [] });
      return json({});
    });

    render(<App />);
    const email = await screen.findByLabelText('Email');
    fireEvent.change(email, { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'supersecret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const totpField = await screen.findByLabelText('Authenticator code');
    fireEvent.change(totpField, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(window.localStorage.getItem('cb.session.token')).toBe('tok-2fa');
    });
  });
});
