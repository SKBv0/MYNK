/**
 * Opening the app: empty library, hydration from disk, and the guarantee that an unreadable library
 * is never overwritten. Only `invoke()` is faked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { deferred, ipcReject, libraryLoad, mockRust, stopRust, type RustMock } from '../test/ipc';
import { flush, renderApp, resetApp, seed, store, toastMessages } from '../test/app';
import { makeResource, NOW } from '../test/fixtures';
import { flushPersistence } from './persistence';
import { deleteResourcesWithMedia } from './jobs/preview';
import { BACKUP_KEY_PREFIX, PERSIST_VERSION } from './migrate';
import { nth } from '../test/assert';

let rust: RustMock;

const v3Payload = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: PERSIST_VERSION,
    savedAt: NOW,
    resources: [
      makeResource({ title: 'Tokio docs', url: 'https://tokio.rs/' }),
      makeResource({ title: 'React docs', url: 'https://react.dev/' }),
    ],
    collections: [],
    chats: {},
    settings: {
      lang: 'en',
      theme: { bg: '#0b0b0d', accent: '#facc15', accentRGB: '250, 204, 21' },
      themeMode: 'dark',
      viewMode: 'grid',
      isSidebarCollapsed: true,
    },
    healthMeta: { hasRun: false, lastScanAt: null },
    ...patch,
  });

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  stopRust();
});

describe('startup', () => {
  it('shows the empty-library state with both ways to get started', async () => {
    await renderApp();

    expect(screen.getByRole('heading', { name: 'Your library is empty' })).toBeInTheDocument();
    expect(
      screen.getByText('Import your browser bookmarks or add your first bookmark.'),
    ).toBeVisible();
    // The header's primary action plus the one inside the empty state.
    expect(screen.getAllByRole('button', { name: 'Add bookmark' }).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(screen.getByRole('button', { name: 'Import bookmarks' })).toBeInTheDocument();
    expect(store().resources).toHaveLength(0);
  });

  it('hydrates records and settings from the stored library', async () => {
    rust.on('library_load', () => libraryLoad(v3Payload()));
    await renderApp();

    expect(await screen.findByText('Tokio docs')).toBeInTheDocument();
    expect(screen.getByText('React docs')).toBeInTheDocument();
    expect(store().isSidebarCollapsed).toBe(true);
    expect(store().resources).toHaveLength(2);
    // Loading alone writes nothing back.
    await flushPersistence();
    expect(rust.countOf('library_save')).toBe(0);
  });

  it('persists a user change back to the library file', async () => {
    rust.on('library_load', () => libraryLoad(v3Payload()));
    await renderApp();

    const id = nth(store().resources, 0).id;
    store().toggleFavorite(id);
    await flushPersistence();

    expect(rust.countOf('library_save')).toBe(1);
    const saved = JSON.parse(nth(rust.argsOf('library_save'), 0).json as string) as {
      version: number;
      resources: { id: string; isFavorite: boolean }[];
    };
    expect(saved.version).toBe(PERSIST_VERSION);
    expect(saved.resources.find((r) => r.id === id)?.isFavorite).toBe(true);
  });

  it('never writes transient state such as the search box or the selection', async () => {
    rust.on('library_load', () => libraryLoad(v3Payload()));
    await renderApp();

    fireEvent.change(screen.getByLabelText('Search bookmarks'), { target: { value: 'tokio' } });
    await waitFor(() => expect(store().searchQuery).toBe('tokio'));
    store().selectResource(nth(store().resources, 0).id);
    store().toggleBatch(nth(store().resources, 0).id);
    store().goToPage('health');
    store().pushToast('just a message');

    await flushPersistence();
    expect(rust.countOf('library_save')).toBe(0);
  });

  it('refuses to overwrite a library file it cannot parse and tells the user', async () => {
    // Claims the current schema but has no resource list: `CorruptLibraryError`.
    rust.on('library_load', () => libraryLoad('{"version":3,"savedAt":1}'));
    await renderApp();

    expect(store().hydrated).toBe(true);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your library could not be loaded');
    expect(Object.keys(window.localStorage).some((k) => k.startsWith(BACKUP_KEY_PREFIX))).toBe(
      true,
    );

    // Writes stay blocked for the whole session, even when the user edits something.
    store().addResource({ url: 'https://example.com/new' });
    await flushPersistence();
    expect(rust.countOf('library_save')).toBe(0);
  });

  it('blocks writes when the library file cannot be read at all', async () => {
    rust.on('library_load', () => {
      throw { kind: 'storage', message: 'disk on fire' };
    });
    await renderApp();

    expect(await screen.findByRole('alert')).toHaveTextContent('Your library could not be loaded');
    store().addResource({ url: 'https://example.com/new' });
    await flushPersistence();
    expect(rust.countOf('library_save')).toBe(0);
  });
});

describe('startup from the backup file', () => {
  it('tells the user once that the library was restored from its backup', async () => {
    rust.on('library_load', () => libraryLoad(v3Payload(), true));
    await renderApp();

    expect(await screen.findByText('Tokio docs')).toBeInTheDocument();
    await waitFor(() =>
      expect(toastMessages().filter((m) => m.includes('restored from its backup'))).toHaveLength(1),
    );
    // Nothing to write back and no error: the backup becomes the library.
    await flushPersistence();
    expect(rust.countOf('library_save')).toBe(0);
    expect(store().toasts.some((t) => t.type === 'error')).toBe(false);
  });

  it('says nothing about a backup on a normal start', async () => {
    rust.on('library_load', () => libraryLoad(v3Payload()));
    await renderApp();
    expect(await screen.findByText('Tokio docs')).toBeInTheDocument();
    await flush();
    expect(toastMessages().join('\n')).not.toContain('backup');
  });
});

describe('startup when the library cannot be loaded', () => {
  it('warns once, on the first change, that changes are not being saved', async () => {
    rust.on('library_load', () => ipcReject('storage', 'library.json is locked'));
    await renderApp();
    await screen.findByRole('alert');
    expect(toastMessages().join('\n')).not.toContain('not being saved');

    store().addResource({ url: 'https://example.com/one' });
    store().addResource({ url: 'https://example.com/two' });
    await flushPersistence();

    const warnings = store().toasts.filter((t) => t.message.includes('not being saved'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.type).toBe('error');
    expect(rust.countOf('library_save')).toBe(0);
  });

  it('never runs snapshot maintenance or deletes media against the empty store', async () => {
    rust.on('library_load', () => ipcReject('storage', 'library.json is locked'));
    await renderApp();

    expect(await screen.findByRole('alert')).toHaveTextContent('Your library could not be loaded');
    // The directory is still resolved so images of new records can render …
    await waitFor(() => expect(store().mediaReady).toBe(true));
    await flush();
    // … but the empty store is not the list of files to keep.
    expect(rust.countOf('maintain_snapshots')).toBe(0);
    expect(rust.countOf('cache_remote_image')).toBe(0);

    // A record added in this session may share a cached file with the unreadable library.
    const added = makeResource({
      url: 'https://shared.example.com/',
      media: { faviconFile: 'f.ico' },
    });
    seed({ resources: [added] });
    deleteResourcesWithMedia([added.id]);
    await flush();
    expect(rust.countOf('delete_snapshots')).toBe(0);
  });

  it('runs the maintenance once the library loaded normally', async () => {
    rust.on('library_load', () => libraryLoad(v3Payload()));
    await renderApp();
    await waitFor(() => expect(rust.countOf('maintain_snapshots')).toBe(1));
  });
});

describe('desktop persistence failures', () => {
  it('tells the user when saving fails and retries until the change is on disk', async () => {
    let attempts = 0;
    rust.on('library_load', () => libraryLoad(v3Payload()));
    rust.on('library_save', () => {
      attempts += 1;
      return attempts === 1 ? ipcReject('storage', 'disk full') : null;
    });
    await renderApp();

    const id = nth(store().resources, 0).id;
    store().toggleFavorite(id);
    await flushPersistence();

    const failure = store().toasts.find((t) => t.type === 'error');
    expect(failure?.message).toContain('Your changes could not be saved');
    // The raw backend text goes to the log, not into the translated message.
    expect(failure?.message).not.toContain('disk full');
    await waitFor(() => expect(rust.countOf('library_save')).toBe(2), { timeout: 3000 });
    const saved = JSON.parse(nth(rust.argsOf('library_save'), 1).json as string) as {
      resources: { id: string; isFavorite: boolean }[];
    };
    expect(saved.resources.find((r) => r.id === id)?.isFavorite).toBe(true);
    await flushPersistence();
    expect(rust.countOf('library_save')).toBe(2);
  });

  it('never lets an older snapshot land after a newer one', async () => {
    const slow = deferred<null>();
    let attempts = 0;
    rust.on('library_load', () => libraryLoad(v3Payload()));
    rust.on('library_save', () => {
      attempts += 1;
      return attempts === 1 ? slow.promise : null;
    });
    await renderApp();

    const ids = store().resources.map((r) => r.id);
    const first = nth(ids, 0);
    const second = nth(ids, 1);
    store().toggleFavorite(first);
    void flushPersistence();
    store().toggleFavorite(second);
    const latest = flushPersistence();
    await flush();

    // The second write waits for the first instead of racing it.
    expect(rust.countOf('library_save')).toBe(1);
    slow.resolve(null);
    await latest;

    expect(rust.countOf('library_save')).toBe(2);
    type Saved = { resources: { id: string; isFavorite: boolean }[] };
    const saves = rust
      .argsOf('library_save')
      .map((args) => JSON.parse(args.json as string) as Saved);
    const older = nth(saves, 0);
    const newer = nth(saves, 1);
    expect(older.resources.filter((r) => r.isFavorite).map((r) => r.id)).toEqual([first]);
    expect(
      newer.resources
        .filter((r) => r.isFavorite)
        .map((r) => r.id)
        .sort(),
    ).toEqual([first, second].sort());
  });
});
