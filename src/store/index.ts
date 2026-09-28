/**
 * Single Zustand store composed from domain slices.
 * Components read through selectors only (`useAppStore((s) => s.x)` / `useShallow`).
 * Persistence is handled by `store/persistence.ts` (data slices only, debounced).
 */
import { create } from 'zustand';
import { translations, type TranslationSchema } from '../translations';
import { setFormatLanguage } from '../lib/format';
import type { AppState } from './state';
import { createUiSlice } from './slices/ui';
import { createLibrarySlice } from './slices/library';
import { createCollectionsSlice } from './slices/collections';
import { createSelectionSlice } from './slices/selection';
import { createChatsSlice } from './slices/chats';
import { createJobsSlice } from './slices/jobs';
import { createToastsSlice } from './slices/toasts';

export type { AppState };

export const useAppStore = create<AppState>()((...args) => ({
  ...createUiSlice(...args),
  ...createLibrarySlice(...args),
  ...createCollectionsSlice(...args),
  ...createSelectionSlice(...args),
  ...createChatsSlice(...args),
  ...createJobsSlice(...args),
  ...createToastsSlice(...args),
}));

/** Translations for non-React code (jobs, persistence, error reporting). */
export const getT = (): TranslationSchema => translations[useAppStore.getState().lang];

// Keep `fmt` / Intl helpers (lib/format.ts) in the UI language, also for non-React callers.
setFormatLanguage(useAppStore.getState().lang);
useAppStore.subscribe((state, prev) => {
  if (state.lang !== prev.lang) setFormatLanguage(state.lang);
});
