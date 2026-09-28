import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mockRust, stopRust, type RustMock } from '../test/ipc';
import { renderApp, resetApp, seedLibrary, store, waitForToast } from '../test/app';
import { setMediaMatches } from '../test/dom';
import { makeResource } from '../test/fixtures';
import { WIDE_LAYOUT_QUERY } from '../hooks/useMediaQuery';
import { nth } from '../test/assert';

let rust: RustMock;

const TOKIO = makeResource({
  url: 'https://tokio.rs/',
  title: 'Tokio',
  description: 'An async runtime for Rust.',
  tags: ['rust', 'async'],
  folderPath: ['Bookmarks bar', 'Dev'],
  summary: ['Work-stealing scheduler.', 'Built on mio.'],
  categoryId: 'development',
});

const openInspector = async (title = 'Tokio') => {
  fireEvent.click(await screen.findByRole('button', { name: `Show details for ${title}` }));
  return screen.findByRole('complementary', { name: 'Bookmark details' });
};

const current = () => nth(store().resources, 0);

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  vi.restoreAllMocks();
  stopRust();
});

describe('bookmark details', () => {
  it('shows every field the record holds', async () => {
    seedLibrary([TOKIO]);
    await renderApp();
    const panel = await openInspector();

    expect(within(panel).getByText('Tokio')).toBeInTheDocument();
    expect(within(panel).getByText('An async runtime for Rust.')).toBeInTheDocument();
    expect(within(panel).getByText('https://tokio.rs/')).toBeInTheDocument();
    expect(within(panel).getByText('#rust')).toBeInTheDocument();
    expect(within(panel).getByText('Bookmarks bar › Dev')).toBeInTheDocument();
    expect(within(panel).getByText('Work-stealing scheduler.')).toBeInTheDocument();
  });

  it('renames the bookmark and protects the new title from the AI', async () => {
    seedLibrary([TOKIO]);
    await renderApp();
    const panel = await openInspector();

    fireEvent.click(within(panel).getByRole('button', { name: 'Rename' }));
    const field = within(panel).getByLabelText('Title');
    fireEvent.change(field, { target: { value: 'Tokio — async runtime' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(current().title).toBe('Tokio — async runtime'));
    expect(current().titleEditedByUser).toBe(true);
  });

  it('Escape cancels the rename without closing the panel', async () => {
    seedLibrary([TOKIO]);
    await renderApp();
    const panel = await openInspector();

    fireEvent.click(within(panel).getByRole('button', { name: 'Rename' }));
    const field = within(panel).getByLabelText('Title');
    fireEvent.change(field, { target: { value: 'Throwaway' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    await waitFor(() => expect(within(panel).queryByLabelText('Title')).toBeNull());
    expect(current().title).toBe('Tokio');
    expect(store().selectedResourceId).toBe(TOKIO.id);
  });

  it('toggles the favorite from the panel', async () => {
    seedLibrary([TOKIO]);
    await renderApp();
    const panel = await openInspector();

    fireEvent.click(within(panel).getByRole('button', { name: 'Add to favorites' }));
    await waitFor(() => expect(current().isFavorite).toBe(true));

    fireEvent.click(within(panel).getByRole('button', { name: 'Remove from favorites' }));
    await waitFor(() => expect(current().isFavorite).toBe(false));
  });

  it('copies the address and opens the page in the system browser', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    seedLibrary([TOKIO]);
    await renderApp();
    const panel = await openInspector();

    fireEvent.click(within(panel).getByRole('button', { name: 'Copy address' }));
    await waitForToast('Address copied.');
    expect(writeText).toHaveBeenCalledWith('https://tokio.rs/');

    fireEvent.click(within(panel).getByRole('button', { name: 'Open in browser' }));
    await waitFor(() => expect(rust.countOf('open_external_url')).toBe(1));
    expect(nth(rust.argsOf('open_external_url'), 0)).toEqual({ url: 'https://tokio.rs/' });
    await waitFor(() => expect(current().lastOpenedAt).not.toBeNull());
  });

  it('explains an unanalyzed bookmark and re-runs the analysis on request', async () => {
    rust.on('analyze_url', () => ({
      title: 'Tokio',
      description: 'Fresh description',
      categoryId: 'development',
      tags: ['rust'],
      summary: ['Fresh point.'],
      insufficientContent: false,
      confidence: 0.7,
      finalUrl: 'https://tokio.rs/',
    }));
    seedLibrary([{ ...TOKIO, ai: { status: 'failed', analyzedAt: null, confidence: null } }]);
    await renderApp();
    const panel = await openInspector();

    expect(within(panel).getByText(/Could not analyze/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Analyze again' }));

    await waitFor(() => expect(current().ai.status).toBe('ok'));
    // Never analyzed before, so the description it came with stays; the summary is the model's.
    expect(current().description).toBe('An async runtime for Rust.');
    expect(current().summary).toEqual(['Fresh point.']);
  });

  it('says why the link is broken', async () => {
    seedLibrary([{ ...TOKIO, health: { status: 'dead', checkedAt: 1, errorKind: 'dns' } }]);
    await renderApp();
    const panel = await openInspector();

    expect(within(panel).getByText('Broken link: Address not found')).toBeInTheDocument();
  });

  it('offers the address an analysis ended on and switches to it', async () => {
    rust.on('analyze_url', () => ({
      title: 'Tokio',
      description: '',
      categoryId: 'development',
      tags: [],
      summary: [],
      insufficientContent: false,
      confidence: 0.7,
      finalUrl: 'https://tokio.rs/en/',
    }));
    seedLibrary([TOKIO]);
    await renderApp();
    const panel = await openInspector();
    fireEvent.click(within(panel).getByRole('button', { name: 'Analyze' }));

    expect(await within(panel).findByText('Redirects to tokio.rs/en/')).toBeInTheDocument();
    fireEvent.click(
      within(panel).getByRole('button', {
        name: 'Use tokio.rs/en/ as this bookmark’s address',
      }),
    );

    await waitForToast('Address updated.');
    expect(current()).toMatchObject({ url: 'https://tokio.rs/en/', urlKey: 'tokio.rs/en' });
    expect(within(panel).queryByText(/Redirects to/)).toBeNull();
  });

  it('points to the saved record instead of creating a duplicate address', async () => {
    const docs = makeResource({ url: 'https://tokio.rs/en/', title: 'Tokio docs' });
    seedLibrary([TOKIO, docs]);
    await renderApp();
    store().noteFinalUrls([{ url: TOKIO.url, finalUrl: 'https://tokio.rs/en/' }]);
    const panel = await openInspector();

    expect(
      await within(panel).findByText(/Already in your library as “Tokio docs”/),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /as this bookmark’s address/ })).toBeNull();
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Open the bookmark at tokio.rs/en/' }),
    );

    await waitFor(() => expect(store().selectedResourceId).toBe(docs.id));
    expect(store().resources.map((r) => r.url)).toEqual([
      'https://tokio.rs/',
      'https://tokio.rs/en/',
    ]);
  });

  it('closes with the panel button and clears the selection', async () => {
    seedLibrary([TOKIO]);
    await renderApp();
    const panel = await openInspector();

    fireEvent.click(within(panel).getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(store().selectedResourceId).toBeNull());
    expect(screen.queryByRole('complementary', { name: 'Bookmark details' })).toBeNull();
  });

  it('docks the panel on a wide window and hands focus back to the card', async () => {
    setMediaMatches({ [WIDE_LAYOUT_QUERY]: true });
    seedLibrary([TOKIO]);
    await renderApp();

    const card = await screen.findByRole('button', { name: 'Show details for Tokio' });
    card.focus();
    fireEvent.click(card);

    const panel = await screen.findByRole('complementary', { name: 'Bookmark details' });
    await waitFor(() =>
      expect(within(panel).getByRole('heading', { name: 'Details' })).toHaveFocus(),
    );

    fireEvent.click(within(panel).getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(card).toHaveFocus());
  });

  it('favoriting from the card moves it into the Favorites scope', async () => {
    seedLibrary([TOKIO]);
    await renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Add to favorites' }));
    await waitFor(() => expect(current().isFavorite).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /^Favorites/ }));
    expect(await screen.findByText('Tokio')).toBeInTheDocument();
  });
});
