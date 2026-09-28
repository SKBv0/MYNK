import type { StateCreator } from 'zustand';
import type {
  AiSetupNotice,
  ConfirmRequest,
  Language,
  ModalId,
  SettingsTabId,
  ThemeConfig,
} from '../../types';
import type { AppState } from '../state';
import type { Page, Scope, ViewMode } from '../../lib/nav';
import { DEFAULT_ACCENT, type ThemeMode } from '../../lib/theme';

export const DEFAULT_THEME: ThemeConfig = { accent: DEFAULT_ACCENT };

export interface UiSlice {
  /** Persisted data has been loaded. Nothing is written before this. */
  hydrated: boolean;
  /** Snapshot directory is known, so snapshot file names can be turned into asset URLs. */
  mediaReady: boolean;
  /** Top-level page. The library page is further split into `scope` × `viewMode`. */
  page: Page;
  /** How the library is shown (persisted). */
  viewMode: ViewMode;
  /** What part of the library is shown: everything, favorites or one collection. */
  scope: Scope;
  lang: Language;
  theme: ThemeConfig;
  themeMode: ThemeMode;
  isSidebarCollapsed: boolean;
  activeModal: ModalId | null;
  confirmRequest: ConfirmRequest | null;
  /** Settings tab the app asked for; `SettingsView` consumes it. Transient, never persisted. */
  settingsTabRequest: SettingsTabId | null;
  /** Why the AI settings tab was opened for the user. Transient, never persisted. */
  aiSetupNotice: AiSetupNotice | null;

  setHydrated: (hydrated: boolean) => void;
  setMediaReady: (ready: boolean) => void;
  goToPage: (page: Page) => void;
  /** Switches the library view; the scope is kept (e.g. "favorites as a graph"). */
  setViewMode: (mode: ViewMode) => void;
  /** Opens the library with the given scope; the view mode is kept. */
  setScope: (scope: Scope) => void;
  /** Opens a collection as the library scope and clears the search. */
  openCollection: (id: string) => void;
  setLang: (lang: Language) => void;
  setTheme: (theme: ThemeConfig) => void;
  setThemeMode: (mode: ThemeMode) => void;
  toggleSidebar: () => void;
  openModal: (modal: ModalId) => void;
  closeModal: () => void;
  requestConfirm: (request: ConfirmRequest) => void;
  resolveConfirm: (confirmed: boolean) => void;
  /** Opens Settings on `tab`, optionally explaining why with a notice on the AI tab. */
  openSettings: (tab: SettingsTabId, notice?: AiSetupNotice) => void;
  consumeSettingsTabRequest: () => void;
  dismissAiSetupNotice: () => void;
}

export const createUiSlice: StateCreator<AppState, [], [], UiSlice> = (set, get) => ({
  hydrated: false,
  mediaReady: false,
  page: 'library',
  viewMode: 'grid',
  scope: 'all',
  lang: 'en',
  theme: DEFAULT_THEME,
  themeMode: 'dark',
  isSidebarCollapsed: false,
  activeModal: null,
  confirmRequest: null,
  settingsTabRequest: null,
  aiSetupNotice: null,

  setHydrated: (hydrated) => set({ hydrated }),
  setMediaReady: (mediaReady) => set({ mediaReady }),
  // Leaving Settings drops the notice; it only makes sense next to the AI form.
  goToPage: (page) => set(page === 'settings' ? { page } : { page, aiSetupNotice: null }),
  setViewMode: (viewMode) => set({ viewMode, page: 'library', aiSetupNotice: null }),
  setScope: (scope) => set({ scope, page: 'library', aiSetupNotice: null }),
  openCollection: (id) =>
    set({ scope: { collectionId: id }, page: 'library', searchQuery: '', aiSetupNotice: null }),
  setLang: (lang) => set({ lang }),
  setTheme: (theme) => set({ theme }),
  setThemeMode: (themeMode) => set({ themeMode }),
  toggleSidebar: () => set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),
  openModal: (activeModal) => set({ activeModal }),
  closeModal: () => set({ activeModal: null }),
  requestConfirm: (confirmRequest) => set({ confirmRequest }),
  resolveConfirm: (confirmed) => {
    const request = get().confirmRequest;
    set({ confirmRequest: null });
    if (confirmed) request?.onConfirm();
  },
  openSettings: (tab, notice) =>
    set({ page: 'settings', settingsTabRequest: tab, aiSetupNotice: notice ?? null }),
  consumeSettingsTabRequest: () => set({ settingsTabRequest: null }),
  dismissAiSetupNotice: () => set({ aiSetupNotice: null }),
});
