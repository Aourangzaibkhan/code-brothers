import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { LanguageSwitcher } from '../components/ui';
import { setLanguage } from '../i18n';
import '../i18n';

describe('language switcher / RTL', () => {
  it('flips document.dir to rtl for Urdu and back to ltr for English', async () => {
    render(<LanguageSwitcher />);
    const select = screen.getByLabelText('Language') as HTMLSelectElement;

    await act(async () => {
      fireEvent.change(select, { target: { value: 'ur' } });
    });
    expect(document.documentElement.dir).toBe('rtl');
    expect(window.localStorage.getItem('cb.language')).toBe('ur');

    await act(async () => {
      fireEvent.change(select, { target: { value: 'ar' } });
    });
    expect(document.documentElement.dir).toBe('rtl');

    await act(async () => {
      fireEvent.change(select, { target: { value: 'en' } });
    });
    expect(document.documentElement.dir).toBe('ltr');

    await act(async () => {
      await setLanguage('en');
    });
  });
});
