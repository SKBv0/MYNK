/** Boots the whole app under test: real store, real job queues, real components; IPC is faked. */
import { createElement } from 'react';
import { act, render, waitFor, type RenderResult } from '@testing-library/react';
import { expect } from 'vitest';
import App from '../App';
import { useAppStore, type AppState } from '../store';
import { __resetPersistenceForTests } from '../store/persistence';
import { resetMediaCacheForTests } from '../store/jobs/media';
import { resetEnrichmentForTests } from '../store/jobs/enrich';
import { resetPreviewForTests } from '../store/jobs/preview';
import { resetHealthScanForTests } from '../store/jobs/health';
import { resetInboxForTests } from '../store/jobs/inbox';
import { resetUpdateJobForTests } from '../store/jobs/update';
import { resetJobHudForTests } from '../store/jobs/shared';
import { resetSnapshotDirForTests } from '../services/snapshots';
import { resetUpdaterForTests } from '../services/updater';
import { LIBRARY_STORAGE_KEY } from '../store/migrate';
import type { Collection, Resource } from '../types';
import { installDomStubs, setMediaMatches } from './dom';

/** The store exactly as the slices created it, captured before any test touched it. */
const PRISTINE = useAppStore.getState();

/** Resets every piece of module-level state the app keeps outside React. */
export const resetApp = (): void => {
  installDomStubs();
  setMediaMatches({});
  resetEnrichmentForTests();
  resetPreviewForTests();
  resetHealthScanForTests();
  resetInboxForTests();
  resetUpdateJobForTests();
  resetMediaCacheForTests();
  resetJobHudForTests();
  resetSnapshotDirForTests();
  resetUpdaterForTests();
  __resetPersistenceForTests();
  useAppStore.setState(PRISTINE, true);
  window.localStorage.clear();
};

/** Puts data into the store without going through persistence. */
export const seed = (patch: Partial<AppState>): void => {
  useAppStore.setState(patch);
};

export const seedLibrary = (resources: Resource[], collections: Collection[] = []): void => {
  seed({ resources, collections, hydrated: true });
};

export const store = (): AppState => useAppStore.getState();

/** Renders the full app shell and waits until hydration finished. */
export const renderApp = async (): Promise<RenderResult> => {
  const utils = render(createElement(App));
  await waitFor(() => expect(useAppStore.getState().hydrated).toBe(true));
  return utils;
};

/** Toast messages currently in the store, newest last. */
export const toastMessages = (): string[] => store().toasts.map((t) => t.message);

export const hasToast = (fragment: string): boolean =>
  toastMessages().some((message) => message.includes(fragment));

export const waitForToast = (fragment: string): Promise<void> =>
  waitFor(() => expect(toastMessages().join('\n')).toContain(fragment));

/** Lets pending microtasks and `setTimeout(0)` callbacks run inside `act`. */
export const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

export { LIBRARY_STORAGE_KEY };
