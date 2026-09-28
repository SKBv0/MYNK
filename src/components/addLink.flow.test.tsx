import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AnalyzeResult } from '../services/ipcTypes';
import { deferred, ipcReject, mockRust, stopRust, type RustMock } from '../test/ipc';
import { renderApp, resetApp, seedLibrary, store, waitForToast } from '../test/app';
import { makeResource } from '../test/fixtures';
import { nth } from '../test/assert';

let rust: RustMock;

const analysis = (patch: Partial<AnalyzeResult> = {}): AnalyzeResult => ({
  title: 'The Rust Programming Language',
  description: 'A language empowering everyone to build reliable software.',
  categoryId: 'development',
  tags: ['rust', 'systems'],
  summary: ['Memory safety without a garbage collector.'],
  insufficientContent: false,
  confidence: 0.9,
  finalUrl: 'https://rust-lang.org/',
  ...patch,
});

const openAddDialog = async () => {
  fireEvent.click(nth(screen.getAllByRole('button', { name: 'Add bookmark' }), 0));
  return screen.findByRole('dialog', { name: 'Add bookmark' });
};

const submitUrl = async (url: string) => {
  const dialog = await openAddDialog();
  fireEvent.change(within(dialog).getByLabelText('Address'), { target: { value: url } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
  return dialog;
};

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  stopRust();
});

describe('adding a link', () => {
  it('saves the link, analyses it and applies the result', async () => {
    rust.on('analyze_url', () => analysis());
    await renderApp();
    await submitUrl('rust-lang.org');

    await waitFor(() => expect(store().resources).toHaveLength(1));
    expect(store().resources[0]?.url).toBe('https://rust-lang.org/');
    await waitForToast('Bookmark added');

    await waitFor(() => expect(store().resources[0]?.ai.status).toBe('ok'));
    const saved = nth(store().resources, 0);
    expect(saved.title).toBe('The Rust Programming Language');
    expect(saved.categoryId).toBe('development');
    expect(saved.tags).toEqual(['rust', 'systems']);
    expect(saved.summary).toEqual(['Memory safety without a garbage collector.']);
    expect(nth(rust.argsOf('analyze_url'), 0)).toMatchObject({ url: 'https://rust-lang.org/' });
    expect(screen.queryByRole('dialog', { name: 'Add bookmark' })).toBeNull();
    expect(await screen.findByText('The Rust Programming Language')).toBeInTheDocument();
  });

  it('captures a screenshot only when the page has no image of its own', async () => {
    rust.on('analyze_url', () => analysis());
    rust.on('capture_snapshot', () => ({ kind: 'image', fileName: 'shot-1.png' }));
    await renderApp();
    await submitUrl('https://rust-lang.org/');

    await waitFor(() => expect(rust.countOf('capture_snapshot')).toBe(1));
    await waitFor(() => expect(store().resources[0]?.media.snapshotFile).toBe('shot-1.png'));
  });

  it('skips the screenshot when the analysis found an og:image', async () => {
    rust.on('analyze_url', () => analysis({ imageUrl: 'https://rust-lang.org/og.png' }));
    await renderApp();
    await submitUrl('https://rust-lang.org/');

    await waitFor(() => expect(store().resources[0]?.ai.status).toBe('ok'));
    expect(store().resources[0]?.media.imageUrl).toBe('https://rust-lang.org/og.png');
    expect(rust.countOf('capture_snapshot')).toBe(0);
  });

  it('reports an invalid address inline and keeps the dialog open', async () => {
    await renderApp();
    const dialog = await submitUrl('not a url');

    const field = within(dialog).getByLabelText('Address');
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(within(dialog).getByText('Enter a valid address (http or https).')).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription('Enter a valid address (http or https).');
    expect(store().resources).toHaveLength(0);
    expect(rust.countOf('analyze_url')).toBe(0);
    expect(store().toasts).toHaveLength(0);
  });

  it('accepts an intranet address when the scheme is typed out, like the importer', async () => {
    rust.on('analyze_url', () => analysis({ finalUrl: 'http://wiki/' }));
    await renderApp();
    await submitUrl('http://wiki/');

    await waitFor(() => expect(store().resources).toHaveLength(1));
    expect(store().resources[0]?.url).toBe('http://wiki/');
    await waitForToast('Bookmark added');
  });

  it('still rejects a bare word without a scheme', async () => {
    await renderApp();
    const dialog = await submitUrl('wiki');

    await waitFor(() =>
      expect(within(dialog).getByLabelText('Address')).toHaveAttribute('aria-invalid', 'true'),
    );
    expect(store().resources).toHaveLength(0);
  });

  it('warns that the link will not be saved when the library could not be loaded', async () => {
    rust.on('library_load', () => ipcReject('storage', 'library.json is locked'));
    rust.on('analyze_url', () => analysis());
    await renderApp();
    await submitUrl('https://rust-lang.org/');

    await waitForToast('Bookmark added');
    await waitForToast('changes in this session are not being saved');
    expect(rust.countOf('library_save')).toBe(0);
  });

  it('selects the existing record instead of adding a duplicate', async () => {
    const existing = makeResource({ url: 'https://rust-lang.org/', title: 'Rust' });
    seedLibrary([existing]);
    await renderApp();
    await submitUrl('rust-lang.org/?utm_source=newsletter');

    await waitForToast('already in your library');
    expect(store().resources).toHaveLength(1);
    expect(store().selectedResourceId).toBe(existing.id);
    expect(rust.countOf('analyze_url')).toBe(0);
  });

  it('marks the record as failed and explains why when the analysis errors', async () => {
    rust.on('analyze_url', () => {
      throw { kind: 'provider', message: 'bad request', status: 400 };
    });
    await renderApp();
    await submitUrl('https://rust-lang.org/');

    await waitFor(() => expect(store().resources[0]?.ai.status).toBe('failed'));
    expect(store().resources[0]?.ai.error).toContain('bad request');
    await waitForToast('Could not analyze');
    expect(rust.countOf('capture_snapshot')).toBe(0);
  });

  it('offers a retry on the failure notification and succeeds on the second try', async () => {
    let attempt = 0;
    rust.on('analyze_url', () => {
      attempt += 1;
      if (attempt === 1) throw { kind: 'parse', message: 'unreadable' };
      return analysis();
    });
    await renderApp();
    await submitUrl('https://rust-lang.org/');

    await waitFor(() => expect(store().resources[0]?.ai.status).toBe('failed'));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(store().resources[0]?.ai.status).toBe('ok'));
    expect(store().resources[0]?.title).toBe('The Rust Programming Language');
    expect(store().resources[0]?.ai.error).toBeUndefined();
  });

  it('closes the dialog without saving anything when the user cancels', async () => {
    await renderApp();
    const dialog = await openAddDialog();
    fireEvent.change(within(dialog).getByLabelText('Address'), {
      target: { value: 'https://example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add bookmark' })).toBeNull());
    expect(store().resources).toHaveLength(0);
  });

  it('cancels the running analysis from the background-task card', async () => {
    const pending = deferred<AnalyzeResult>();
    const cancelled: string[] = [];
    rust.on('analyze_url', () => pending.promise);
    rust.on('cancel_request', (args) => {
      cancelled.push(args.requestId as string);
      pending.reject({ kind: 'cancelled', message: 'The request was cancelled.' });
      return null;
    });
    await renderApp();
    await submitUrl('https://rust-lang.org/');

    const hud = await screen.findByRole('region', { name: 'Background tasks' });
    await waitFor(() => expect(store().resources[0]?.ai.status).toBe('pending'));
    fireEvent.click(within(hud).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(cancelled).toHaveLength(1));
    await waitFor(() => expect(store().resources[0]?.ai.status).toBe('none'));
    expect(store().resources[0]?.ai.error).toBeUndefined();
    await waitForToast('Analysis cancelled');
  });

  it('offers to show a link added away from the library and reveals it there', async () => {
    rust.on('analyze_url', () => analysis());
    seedLibrary([makeResource({ url: 'https://tokio.rs/', title: 'Tokio' })]);
    await renderApp();
    act(() => {
      store().setSearchQuery('tokio');
      store().goToPage('settings');
    });

    await submitUrl('rust-lang.org');
    await waitForToast('Bookmark added');
    expect(store().page).toBe('settings');

    fireEvent.click(await screen.findByRole('button', { name: 'Show' }));

    const added = store().resources.find((r) => r.url === 'https://rust-lang.org/');
    expect(store().page).toBe('library');
    // The search would hide the new link, so it is lifted.
    expect(store().searchQuery).toBe('');
    expect(store().selectedResourceId).toBe(added?.id);
  });

  it('adds no Show action when the new card is already in view', async () => {
    rust.on('analyze_url', () => analysis());
    await renderApp();
    await submitUrl('rust-lang.org');
    await waitForToast('Bookmark added');
    expect(
      store().toasts.find((t) => t.message.startsWith('Bookmark added'))?.action,
    ).toBeUndefined();
  });
});
