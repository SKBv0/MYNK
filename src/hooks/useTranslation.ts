import { useMemo } from 'react';
import { useAppStore } from '../store';
import { localeOf } from '../lib/format';
import { translations, type Language, type TranslationSchema } from '../translations';

export interface LanguageContextValue {
  lang: Language;
  t: TranslationSchema;
  setLang: (lang: Language) => void;
  /** BCP-47 locale for Intl formatting. */
  locale: string;
}

export const useTranslation = (): LanguageContextValue => {
  const lang = useAppStore((state) => state.lang);
  const setLang = useAppStore((state) => state.setLang);
  return useMemo(
    () => ({ lang, t: translations[lang], setLang, locale: localeOf(lang) }),
    [lang, setLang],
  );
};
