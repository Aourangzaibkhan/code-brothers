import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ur from './locales/ur.json';
import hi from './locales/hi.json';
import ar from './locales/ar.json';
import ptBR from './locales/pt-BR.json';
import es from './locales/es.json';
import id from './locales/id.json';
import bn from './locales/bn.json';
import tr from './locales/tr.json';
import fr from './locales/fr.json';
import de from './locales/de.json';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'ur', label: 'اردو (Urdu)', dir: 'rtl' },
  { code: 'hi', label: 'हिन्दी (Hindi)', dir: 'ltr' },
  { code: 'ar', label: 'العربية (Arabic)', dir: 'rtl' },
  { code: 'pt-BR', label: 'Português (Brasil)', dir: 'ltr' },
  { code: 'es', label: 'Español', dir: 'ltr' },
  { code: 'id', label: 'Bahasa Indonesia', dir: 'ltr' },
  { code: 'bn', label: 'বাংলা (Bengali)', dir: 'ltr' },
  { code: 'tr', label: 'Türkçe', dir: 'ltr' },
  { code: 'fr', label: 'Français', dir: 'ltr' },
  { code: 'de', label: 'Deutsch', dir: 'ltr' },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

export const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ur', 'ar']);
const STORAGE_KEY = 'cb.language';

/** Applies language direction to the document (spec §1: native RTL mirroring). */
export function applyDirection(lng: string): void {
  const dir = RTL_LANGUAGES.has(lng) ? 'rtl' : 'ltr';
  document.documentElement.dir = dir;
  document.documentElement.lang = lng;
}

export function getStoredLanguage(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? 'en';
  } catch {
    return 'en';
  }
}

/** Switches language, persists the choice and flips document direction. */
export async function setLanguage(lng: string): Promise<void> {
  try {
    window.localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* ignore */
  }
  applyDirection(lng);
  await i18n.changeLanguage(lng);
}

const initialLanguage = getStoredLanguage();
applyDirection(initialLanguage);

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ur: { translation: ur },
    hi: { translation: hi },
    ar: { translation: ar },
    'pt-BR': { translation: ptBR },
    es: { translation: es },
    id: { translation: id },
    bn: { translation: bn },
    tr: { translation: tr },
    fr: { translation: fr },
    de: { translation: de },
  },
  lng: initialLanguage,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export default i18n;
