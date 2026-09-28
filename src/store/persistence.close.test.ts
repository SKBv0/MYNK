import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const win = vi.hoisted(() => {
  let handler: ((event: { preventDefault: () => void }) => void) | null = null;
  return {
    onCloseRequested: vi.fn((fn: (event: { preventDefault: () => void }) => void) => {
      handler = fn;
      return Promise.resolve(() => undefined);
    }),
    close: vi.fn(() => Promise.resolve()),
    requestClose: () => handler?.({ preventDefault: () => undefined }),
  };
});

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));
vi.mock('../services/library', () => ({
  loadLibrary: vi.fn(() => Promise.resolve({ json: null, recoveredFromBackup: false })),
  saveLibrary: vi.fn(() => Promise.resolve()),
}));

import { loadLibrary, saveLibrary } from '../services/library';
import { useAppStore } from './index';
import { __resetPersistenceForTests, hydrateStore } from './persistence';

const initial = useAppStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  useAppStore.setState(initial, true);
  __resetPersistenceForTests();
  win.onCloseRequested.mockClear();
  win.close.mockClear();
  // The close handler only registers for a real window, which the plain IPC mock has no metadata for.
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' } },
  };
});

afterEach(() => {
  __resetPersistenceForTests();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('holding the window open for the last write', () => {
  it('flushes again on a later close when closing the window failed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await hydrateStore();
    await vi.waitFor(() => expect(win.onCloseRequested).toHaveBeenCalled());
    win.close.mockRejectedValueOnce(new Error('the window refused to close'));

    win.requestClose();
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    win.requestClose();

    await vi.waitFor(() => expect(win.close).toHaveBeenCalledTimes(2));
    logged.mockRestore();
  });

  it('asks before closing when the latest changes could not be saved', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(saveLibrary).mockRejectedValue(new Error('disk full'));
    await hydrateStore();
    await vi.waitFor(() => expect(win.onCloseRequested).toHaveBeenCalled());
    useAppStore.getState().toggleSidebar();

    win.requestClose();
    await vi.waitFor(() => expect(useAppStore.getState().confirmRequest).not.toBeNull());
    expect(win.close).not.toHaveBeenCalled();

    useAppStore.getState().resolveConfirm(true);
    await vi.waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));
    vi.mocked(saveLibrary).mockReset();
    vi.mocked(saveLibrary).mockResolvedValue(undefined);
    logged.mockRestore();
  });

  it('closes without asking when an unreadable library was left untouched', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(loadLibrary).mockRejectedValueOnce(new Error('unreadable'));
    await hydrateStore();
    await vi.waitFor(() => expect(win.onCloseRequested).toHaveBeenCalled());

    win.requestClose();
    await vi.waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().confirmRequest).toBeNull();
    logged.mockRestore();
  });
});
