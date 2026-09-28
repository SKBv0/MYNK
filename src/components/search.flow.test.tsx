import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ipcReject, mockRust, stopRust, type RustMock } from '../test/ipc';
import { renderApp, resetApp, seedLibrary, store } from '../test/app';
import { makeCollection, makeResource } from '../test/fixtures';

const RUST = makeResource({
  url: 'https://tokio.rs/',
  title: 'Rust async runtime',
  tags: ['rust', 'tokio'],
  summary: ['Zero-cost futures.'],
  categoryId: 'development',
  isFavorite: true,
});
const YAZILIM = makeResource({
  url: 'https://yazilim.example.com/mimari',
  title: 'Yazılım Mimarisi',
  description: 'Dağıtık sistemlerde ölçeklenebilirlik',
  tags: ['mimari'],
});
const ISTANBUL = makeResource({
  url: 'https://gezi.example.com/istanbul',
  title: 'İstanbul rehberi',
  description: 'Şehir gezisi notları',
});

const seedAll = (collections = [makeCollection({ name: 'Async', keywords: ['tokio'] })]) =>
  seedLibrary([RUST, YAZILIM, ISTANBUL], collections);

const search = (text: string) =>
  fireEvent.change(screen.getByLabelText('Search bookmarks'), { target: { value: text } });

/** Waits for the debounced search to settle on exactly this result set. */
const onlyVisible = async (title: string, hidden: string[]) =>
  waitFor(() => {
    expect(screen.getByText(title)).toBeInTheDocument();
    for (const other of hidden) expect(screen.queryByText(other)).toBeNull();
  });

let rust: RustMock;

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  stopRust();
});

describe('search and filtering', () => {
  it('ignores Turkish diacritics and letter case', async () => {
    seedAll();
    await renderApp();

    search('yazilim');
    await onlyVisible('Yazılım Mimarisi', ['Rust async runtime', 'İstanbul rehberi']);

    search('ISTANBUL');
    await onlyVisible('İstanbul rehberi', ['Yazılım Mimarisi']);

    search('sehir gezisi');
    await onlyVisible('İstanbul rehberi', ['Yazılım Mimarisi']);
  });

  it('matches tags, host and summary text, not just the title', async () => {
    seedAll();
    await renderApp();

    search('tokio');
    await onlyVisible('Rust async runtime', ['Yazılım Mimarisi']);

    search('futures');
    await onlyVisible('Rust async runtime', ['İstanbul rehberi']);

    search('gezi.example.com');
    await onlyVisible('İstanbul rehberi', ['Rust async runtime']);
  });

  it('clears the search box on Escape and leaves the rest of the app alone', async () => {
    seedAll();
    await renderApp();

    search('yazilim');
    await onlyVisible('Yazılım Mimarisi', ['Rust async runtime']);

    const box = screen.getByLabelText('Search bookmarks');
    fireEvent.keyDown(box, { key: 'Escape' });

    expect(store().searchQuery).toBe('');
    await waitFor(() => expect(screen.getByText('Rust async runtime')).toBeInTheDocument());
    expect(store().page).toBe('library');
  });

  it('says the library could not be read rather than offering to import into it', async () => {
    rust.on('library_load', () => ipcReject('storage', 'library.json is locked'));
    await renderApp();

    expect(
      await screen.findByRole('heading', { name: 'Your library could not be read' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your library is empty' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import bookmarks' })).toBeNull();
  });

  it('offers a way back from a search that matches nothing', async () => {
    seedAll();
    await renderApp();

    search('zzzz-nothing');
    expect(await screen.findByRole('heading', { name: 'No bookmarks match' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all bookmarks' }));
    await waitFor(() => expect(screen.getByText('Rust async runtime')).toBeInTheDocument());
    expect(store().searchQuery).toBe('');
    expect(store().scope).toBe('all');
  });

  it('narrows the library to favorites and searches inside that scope', async () => {
    seedAll();
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: /^Favorites/ }));
    await onlyVisible('Rust async runtime', ['Yazılım Mimarisi']);
    expect(screen.getByLabelText('Search bookmarks')).toHaveAttribute(
      'placeholder',
      'Search in Favorites…',
    );

    search('yazilim');
    expect(await screen.findByRole('heading', { name: 'No bookmarks match' })).toBeInTheDocument();
  });

  it('uses the collection keywords as the scope', async () => {
    seedAll();
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: /^Async/ }));
    await onlyVisible('Rust async runtime', ['Yazılım Mimarisi', 'İstanbul rehberi']);
    expect(store().scope).toEqual({ collectionId: store().collections[0]?.id });
  });

  it('includes a pinned bookmark that no keyword matches', async () => {
    const collection = makeCollection({
      name: 'Async',
      keywords: ['tokio'],
      pinnedIds: [ISTANBUL.id],
    });
    seedAll([collection]);
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: /^Async/ }));
    await waitFor(() => expect(screen.getByText('Rust async runtime')).toBeInTheDocument());
    expect(screen.getByText('İstanbul rehberi')).toBeInTheDocument();
    expect(screen.queryByText('Yazılım Mimarisi')).toBeNull();
  });

  it('keeps scope and view independent of each other', async () => {
    seedAll();
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: /^Favorites/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Timeline' }));

    await waitFor(() => expect(store().viewMode).toBe('timeline'));
    expect(store().scope).toBe('favorites');
    expect(screen.getByText('Favorites · Timeline')).toBeInTheDocument();
    expect(
      await screen.findByRole('group', { name: 'Bookmarks by date added' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Rust async runtime')).toBeInTheDocument();
    expect(screen.queryByText('Yazılım Mimarisi')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Async/ }));
    await waitFor(() =>
      expect(store().scope).toEqual({ collectionId: store().collections[0]?.id }),
    );
    expect(store().viewMode).toBe('timeline');
    expect(screen.getByText('Async · Timeline')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Summaries' }));
    await waitFor(() => expect(store().viewMode).toBe('feed'));
    expect(store().scope).toEqual({ collectionId: store().collections[0]?.id });
    expect(await screen.findByText('Zero-cost futures.')).toBeInTheDocument();
  });

  it('shows the same filtered set in the graph view', async () => {
    seedAll();
    await renderApp();

    search('tokio');
    await onlyVisible('Rust async runtime', ['Yazılım Mimarisi']);
    fireEvent.click(screen.getByRole('radio', { name: 'Graph' }));

    const graph = await screen.findByRole('group', {
      name: 'Bookmarks connected by shared tags',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Development, 1 bookmark' }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Rust async runtime (Development)' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Yazılım Mimarisi/ })).toBeNull();
    });
    expect(graph).toBeInTheDocument();
  });
});
