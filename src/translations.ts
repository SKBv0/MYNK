/** UI language index. Dictionaries live in `translations/en.ts` and `translations/tr.ts`. */
import { en, type TranslationSchema } from './translations/en';
import { tr } from './translations/tr';

export type Language = 'en' | 'tr';

export const isLanguage = (value: unknown): value is Language => value === 'en' || value === 'tr';

export type { TranslationSchema };

export const translations: Record<Language, TranslationSchema> = { en, tr };
