/**
 * Library persistence: file storage on desktop, localStorage in browser dev. Only data slices
 * are written, debounced (500 ms, max 3 s) and retried with backoff on failure. A failure streak
 * toasts once.
 */
import { isDesktopRuntime } from '../services/ipc';
import { loadLibrary, saveLibrary } from '../services/library';
import type { LibraryLoadResult } from '../services/ipcTypes';
import { reportError } from '../lib/errors';
import { getT, useAppStore, type AppState } from './index';
import { trimChat } from './model';
import { GLOBAL_CHAT_KEY } from '../types';
import {
  BACKUP_KEY_PREFIX,
  LIBRARY_STORAGE_KEY,
  PERSIST_VERSION,
  parsePersisted,
  type PersistedLibrary,
  type PersistedSettings,
} from './migrate';

/** Idle gap before a write; a steady stream of changes keeps resetting it. */
export const WRITE_DEBOUNCE_MS = 500;
/** Upper bound on the debounce: continuous changes still get a write this often. */
export const WRITE_MAX_WAIT_MS = 3000;
/** First retry delay after a failed write; doubles per consecutive failure. */
export const WRITE_RETRY_BASE_MS = 1000;
export const WRITE_RETRY_MAX_MS = 30_000;

/** Consecutive failed writes after which callers that must not lose data stop consuming more. */
export const SAVE_FAILURE_LIMIT = 3;

/** Outcome of `hydrateStore`: `ok` is false when the library could not be read or parsed. */
export interface HydrateResult {
  ok: boolean;
}

/** Outcome of a flush: `ok` is true only once the current state reached storage. */
export interface FlushResult {
  ok: boolean;
}

export interface LibraryStorage {
  load: () => Promise<LibraryLoadResult>;
  save: (json: string) => Promise<void>;
}

const fileStorage: LibraryStorage = { load: loadLibrary, save: saveLibrary };

// The executor form keeps a synchronous storage failure (e.g. quota exceeded) a rejection.
const localStorageAdapter: LibraryStorage = {
  load: () =>
    new Promise((resolve) =>
      resolve({
        json: window.localStorage.getItem(LIBRARY_STORAGE_KEY),
        recoveredFromBackup: false,
      }),
    ),
  save: (json) =>
    new Promise((resolve) => {
      window.localStorage.setItem(LIBRARY_STORAGE_KEY, json);
      resolve();
    }),
};

const getLibraryStorage = (): LibraryStorage =>
  isDesktopRuntime() ? fileStorage : localStorageAdapter;

const selectPersisted = (state: AppState): PersistedLibrary => ({
  version: PERSIST_VERSION,
  savedAt: Date.now(),
  resources: state.resources,
  collections: state.collections,
  chats: state.chats,
  settings: {
    lang: state.lang,
    theme: state.theme,
    themeMode: state.themeMode,
    viewMode: state.viewMode,
    isSidebarCollapsed: state.isSidebarCollapsed,
  },
  healthMeta: state.healthMeta,
});

const SETTING_KEYS = ['lang', 'theme', 'themeMode', 'viewMode', 'isSidebarCollapsed'] as const;

/** Store state when loading began; what changed since then was done by the user meanwhile. */
let bootState: AppState | null = null;

/** The stored library plus what the user did while it loaded; `changed` means it needs a write. */
const withEarlyEdits = (data: PersistedLibrary): { data: PersistedLibrary; changed: boolean } => {
  const boot = bootState;
  const now = useAppStore.getState();
  if (!boot) return { data, changed: false };
  let changed = false;

  const bootIds = new Set(boot.resources.map((r) => r.id));
  const storedKeys = new Set(data.resources.map((r) => r.urlKey));
  const addedResources = now.resources.filter(
    (r) => !bootIds.has(r.id) && !storedKeys.has(r.urlKey),
  );
  const bootCollections = new Set(boot.collections.map((c) => c.id));
  const addedCollections = now.collections.filter((c) => !bootCollections.has(c.id));
  if (addedResources.length > 0 || addedCollections.length > 0) changed = true;

  const chats = { ...data.chats };
  for (const [key, messages] of Object.entries(now.chats)) {
    const before = boot.chats[key] ?? [];
    if (messages === before) continue;
    const early = messages.filter((message) => !before.includes(message));
    if (early.length === 0) continue;
    chats[key] = trimChat([...(data.chats[key] ?? []), ...early]);
    changed = true;
  }
  // A chat about an early bookmark that was dropped as a duplicate would point at nothing.
  const keptIds = new Set([...data.resources, ...addedResources].map((r) => r.id));
  for (const key of Object.keys(chats)) {
    if (key !== GLOBAL_CHAT_KEY && !keptIds.has(key) && !(key in data.chats)) delete chats[key];
  }

  const settings: PersistedSettings = { ...data.settings };
  const keepSetting = <K extends (typeof SETTING_KEYS)[number]>(key: K) => {
    if (now[key] === boot[key]) return;
    settings[key] = now[key];
    changed = true;
  };
  for (const key of SETTING_KEYS) keepSetting(key);

  return {
    data: {
      ...data,
      resources: [...addedResources, ...data.resources],
      collections: [...addedCollections, ...data.collections],
      chats,
      settings,
    },
    changed,
  };
};

/** Puts the loaded library in the store; returns whether early edits still need writing. */
const applyPersisted = (stored: PersistedLibrary): boolean => {
  const { data, changed } = withEarlyEdits(stored);
  useAppStore.setState({
    resources: data.resources,
    collections: data.collections,
    chats: data.chats,
    lang: data.settings.lang,
    theme: data.settings.theme,
    themeMode: data.settings.themeMode,
    viewMode: data.settings.viewMode,
    isSidebarCollapsed: data.settings.isSidebarCollapsed,
    healthMeta: data.healthMeta,
  });
  return changed;
};

type PersistedRefs = unknown[];

const refsOf = (s: AppState): PersistedRefs => [
  s.resources,
  s.collections,
  s.chats,
  s.lang,
  s.theme,
  s.themeMode,
  s.viewMode,
  s.isSidebarCollapsed,
  s.healthMeta,
];

let storage: LibraryStorage | null = null;
let writeBlocked = false;
let writeBlockedNotified = false;
let dirty = false;
/** When the oldest unsaved change happened (for the debounce ceiling). */
let dirtySince: number | null = null;
/** Bumped on every change; lets a write know whether a newer one superseded it. */
let generation = 0;
/** Generation of the most recent write that was queued. */
let queuedGeneration = 0;
/** What the most recent write serialized; lets hydration see edits made while it ran. */
let lastSerializedRefs: PersistedRefs | null = null;
/** Consecutive failed writes (drives the retry backoff; 0 after a success). */
let failedWrites = 0;
/** The persistent "not being saved" warning of the current failure streak. */
let saveFailingToastId: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<void> = Promise.resolve();
let unsubscribe: (() => void) | null = null;

/** `mynk.backup.<timestamp>` snapshots kept; an unreadable file is backed up on every start. */
export const MAX_BACKUPS = 3;

/** Drops all but the newest {@link MAX_BACKUPS} - 1 backups, so a new one cannot grow the list. */
const pruneBackups = (): void => {
  try {
    const found: { key: string; stamp: number }[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(BACKUP_KEY_PREFIX)) continue;
      found.push({ key, stamp: Number.parseInt(key.slice(BACKUP_KEY_PREFIX.length), 10) });
    }
    const keep = new Set(
      [...new Set(found.map((entry) => entry.stamp))]
        .sort((a, b) => b - a)
        .slice(0, MAX_BACKUPS - 1),
    );
    for (const entry of found) {
      if (!keep.has(entry.stamp)) window.localStorage.removeItem(entry.key);
    }
  } catch (error) {
    console.warn('[MYNK] old backups could not be pruned.', error);
  }
};

/** Stores an unreadable library file under `mynk.backup.<timestamp>`. */
const backupRaw = (raw: string): void => {
  pruneBackups();
  try {
    window.localStorage.setItem(`${BACKUP_KEY_PREFIX}${Date.now()}`, raw);
  } catch (error) {
    console.warn('[MYNK] backup of the unreadable library could not be written.', error);
  }
};

/** True when the stored library could not be read, so nothing may be written or pruned. */
export const isLibraryWriteBlocked = (): boolean => writeBlocked;

/** True after {@link SAVE_FAILURE_LIMIT} consecutive failed writes; retries keep running. */
export const isSaveFailing = (): boolean => failedWrites >= SAVE_FAILURE_LIMIT;

const markDirty = () => {
  dirty = true;
  generation += 1;
  if (dirtySince === null) dirtySince = Date.now();
};

const clearTimer = () => {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
};

const scheduleRetry = () => {
  const delay = Math.min(WRITE_RETRY_MAX_MS, WRITE_RETRY_BASE_MS * 2 ** (failedWrites - 1));
  // A pending debounce timer will write soon anyway.
  if (timer === null) timer = setTimeout(() => void writeNow(), delay);
};

const writeNow = async (): Promise<FlushResult> => {
  clearTimer();
  if (!storage || writeBlocked) return { ok: false };
  if (!dirty) {
    // Nothing new to write, but a write queued earlier may still be in flight.
    await queue;
    return { ok: failedWrites === 0 };
  }
  dirty = false;
  dirtySince = null;
  const target = storage;
  const writeGeneration = generation;
  let json: string;
  try {
    const state = useAppStore.getState();
    json = JSON.stringify(selectPersisted(state));
    lastSerializedRefs = refsOf(state);
  } catch (error) {
    reportError(error, 'persistence.serialize', { prefix: getT().errors.persistence });
    await queue;
    return { ok: false };
  }
  queuedGeneration = writeGeneration;
  /** Whether *this* write reached the storage (a superseded one has not). */
  let stored = false;
  // Serialize writes so an older snapshot can never land after a newer one.
  queue = queue.then(() =>
    target.save(json).then(
      () => {
        failedWrites = 0;
        stored = true;
        if (saveFailingToastId !== null) {
          const toasts = useAppStore.getState();
          toasts.dismissToast(saveFailingToastId);
          saveFailingToastId = null;
          toasts.pushToast(getT().persistence.savingAgain, 'success');
        }
      },
      (error: unknown) => {
        // A newer write is already queued and contains everything this one had.
        if (queuedGeneration !== writeGeneration) {
          reportError(error, 'persistence.save', { toast: false });
          return;
        }
        failedWrites += 1;
        dirty = true;
        if (dirtySince === null) dirtySince = Date.now();
        // One toast per failure streak; the retries are logged only.
        reportError(
          error,
          'persistence.save',
          failedWrites === 1 ? { prefix: getT().errors.persistence } : { toast: false },
        );
        if (isSaveFailing() && saveFailingToastId === null) {
          saveFailingToastId = useAppStore
            .getState()
            .pushToast(getT().persistence.saveFailing, 'error', { durationMs: 0 });
        }
        scheduleRetry();
      },
    ),
  );
  await queue;
  return { ok: stored };
};

/** One persistent warning per session for the first change made while writes are blocked. */
const notifyWriteBlocked = () => {
  if (writeBlockedNotified) return;
  writeBlockedNotified = true;
  useAppStore.getState().pushToast(getT().persistence.notSaving, 'error', { durationMs: 0 });
};

const scheduleWrite = () => {
  if (writeBlocked) {
    notifyWriteBlocked();
    return;
  }
  markDirty();
  // While saves are failing, new changes wait for the pending retry instead of forcing writes.
  if (failedWrites > 0) {
    if (timer === null) scheduleRetry();
    return;
  }
  clearTimer();
  const ceiling = (dirtySince ?? Date.now()) + WRITE_MAX_WAIT_MS - Date.now();
  timer = setTimeout(() => void writeNow(), Math.max(0, Math.min(WRITE_DEBOUNCE_MS, ceiling)));
};

/** Whether a failed flush loses anything: a blocked library with no change this session does not. */
const hasUnsavedChanges = (): boolean => (writeBlocked ? writeBlockedNotified : true);

/**
 * Writes pending changes immediately (window close, app quit) and reports whether they landed.
 * A caller that is about to throw data away once it is stored must check `ok`.
 */
export const flushPersistence = (): Promise<FlushResult> => writeNow();

const onVisibilityChange = () => {
  if (document.visibilityState === 'hidden') void writeNow();
};
const onBeforeUnload = () => void writeNow();

let unlistenClose: (() => void) | null = null;
let closeHandlerRequested = false;
let closing = false;

const hasWindowMetadata = (): boolean => {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: unknown } })
    .__TAURI_INTERNALS__;
  const metadata = internals?.metadata as { currentWindow?: unknown } | undefined;
  return metadata?.currentWindow !== undefined;
};

/**
 * `beforeunload` only queues the write; this holds the window open until the flush lands.
 * Needs both `core:window:allow-close` and `core:window:allow-destroy`.
 */
const registerCloseHandler = (): void => {
  // The test mock installs `__TAURI_INTERNALS__` without window metadata, hence the extra check.
  if (!isDesktopRuntime() || !hasWindowMetadata() || closeHandlerRequested) return;
  // Set before the awaits below so a second `startWriting()` in the same tick can't double-register.
  closeHandlerRequested = true;
  void (async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    unlistenClose = await win.onCloseRequested((event) => {
      // The handler's own `close()` call below re-enters it; that one passes through.
      if (closing) return;
      closing = true;
      event.preventDefault();
      const closeNow = () =>
        win.close().catch((error: unknown) => {
          // A refused close must not leave the next attempt skipping its flush.
          closing = false;
          reportError(error, 'persistence.close', { toast: false });
        });
      void flushPersistence()
        .catch((): FlushResult => ({ ok: false }))
        .then(({ ok }) => {
          if (ok || !hasUnsavedChanges()) {
            void closeNow();
            return;
          }
          closing = false;
          const t = getT().persistence;
          useAppStore.getState().requestConfirm({
            title: t.closeUnsavedTitle,
            message: t.closeUnsavedMessage,
            confirmLabel: t.closeUnsavedConfirm,
            danger: true,
            onConfirm: () => {
              closing = true;
              void closeNow();
            },
          });
        });
    });
  })().catch((error: unknown) => {
    closeHandlerRequested = false;
    reportError(error, 'persistence.close', { toast: false });
  });
};

const refsDiffer = (a: PersistedRefs, b: PersistedRefs): boolean =>
  a.some((ref, index) => ref !== b[index]);

const startWriting = () => {
  unsubscribe?.();
  let previous = refsOf(useAppStore.getState());
  unsubscribe = useAppStore.subscribe((state) => {
    const next = refsOf(state);
    if (!refsDiffer(next, previous)) return;
    previous = next;
    scheduleWrite();
  });
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('visibilitychange', onVisibilityChange);
  registerCloseHandler();
};

const loadIntoStore = async (target: LibraryStorage): Promise<void> => {
  const t = getT();
  let raw: string | null;
  let recoveredFromBackup = false;
  try {
    ({ json: raw, recoveredFromBackup } = await target.load());
  } catch (error) {
    writeBlocked = true;
    reportError(error, 'persistence.load', { prefix: t.errors.persistenceLoad });
    return;
  }

  if (raw) {
    try {
      const data = parsePersisted(raw);
      const hadEarlyEdits = applyPersisted(data);
      if (recoveredFromBackup) {
        useAppStore
          .getState()
          .pushToast(getT().persistence.recoveredFromBackup, 'info', { durationMs: 0 });
      }
      if (hadEarlyEdits) {
        // The subscriber isn't running yet, so early edits must be written here explicitly.
        markDirty();
        await writeNow();
      }
    } catch (error) {
      backupRaw(raw);
      writeBlocked = true;
      reportError(error, 'persistence.parse', { prefix: t.errors.persistenceLoad });
    }
    return;
  }

  // First run: what the user did while the missing file was looked for is the library now.
  if (bootState && refsDiffer(refsOf(useAppStore.getState()), refsOf(bootState))) {
    markDirty();
    await writeNow();
  }
};

/**
 * Loads persisted data, then starts the debounced writer. Always ends
 * `hydrated = true`; `{ ok: false }` means writes are blocked and the store is not the real library.
 */
export const hydrateStore = async (): Promise<HydrateResult> => {
  storage = getLibraryStorage();
  bootState = useAppStore.getState();
  try {
    await loadIntoStore(storage);
  } finally {
    bootState = null;
    useAppStore.getState().setHydrated(true);
    startWriting();
    // An edit made while the post-load write was in flight is not in that write.
    if (lastSerializedRefs && refsDiffer(refsOf(useAppStore.getState()), lastSerializedRefs)) {
      scheduleWrite();
    }
  }
  return { ok: !writeBlocked };
};

export const __resetPersistenceForTests = () => {
  unsubscribe?.();
  unsubscribe = null;
  unlistenClose?.();
  unlistenClose = null;
  closeHandlerRequested = false;
  closing = false;
  clearTimer();
  storage = null;
  bootState = null;
  writeBlocked = false;
  writeBlockedNotified = false;
  dirty = false;
  dirtySince = null;
  generation = 0;
  lastSerializedRefs = null;
  queuedGeneration = 0;
  failedWrites = 0;
  saveFailingToastId = null;
  queue = Promise.resolve();
  window.removeEventListener('beforeunload', onBeforeUnload);
  document.removeEventListener('visibilitychange', onVisibilityChange);
};
