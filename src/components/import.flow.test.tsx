import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { ipcReject, mockRust, stopRust, type RustMock } from '../test/ipc';
import { renderApp, resetApp, seedLibrary, store, waitForToast } from '../test/app';
import { textFile } from '../test/dom';
import { CHROME_JSON, NETSCAPE_HTML, makeResource } from '../test/fixtures';
import { cancelEnrichment, startEnrichment } from '../store/jobs/enrich';

const byTitle = (title: string) => store().resources.find((r) => r.title === title);

/** Settings › Data is where every import lives; the Data tab is the default one. */
const openImportTab = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  return screen.findByText('Import bookmarks', { selector: 'h2' });
};

const chooseFile = async (file: File) => {
  const input = await screen.findByTestId('bookmark-file-input');
  fireEvent.change(input, { target: { files: [file] } });
};

let rust: RustMock;

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  delete (globalThis as { scheduler?: unknown }).scheduler;
  stopRust();
});

describe('importing a bookmark file', () => {
  it('reads a Netscape export with folders and dates, skipping unusable rows', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Import bookmarks' }));
    await screen.findByText('Import bookmarks', { selector: 'h2' });
    await chooseFile(textFile('bookmarks.html', NETSCAPE_HTML));

    await waitFor(() => expect(store().resources).toHaveLength(3));
    // The javascript: link and the one without an address.
    await waitForToast('3 added, 0 already there, 2 skipped (invalid address).');

    const tokio = byTitle('Tokio');
    expect(tokio?.url).toBe('https://tokio.rs/');
    expect(tokio?.folderPath).toEqual(['Bookmarks bar', 'Dev']);
    // Root folders carry no meaning; only the real folder becomes a tag.
    expect(tokio?.tags).toEqual(['dev']);
    expect(tokio?.createdAt).toBe(1_700_000_300_000);

    expect(byTitle('Rust')?.folderPath).toEqual(['Bookmarks bar']);
    expect(byTitle('Rust')?.tags).toEqual([]);
    expect(byTitle('React')?.folderPath).toEqual(['Other bookmarks']);
    expect(store().resources.map((r) => r.url)).not.toContain('javascript:void(0)');
    expect(byTitle('No href at all')).toBeUndefined();
  });

  it('reports a file of unusable links as skipped rather than empty', async () => {
    await renderApp();
    await openImportTab();
    const html = `<DL><p>
      <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
      <DT><A HREF="just some text">Plain text</A>
    </DL><p>`;
    await chooseFile(textFile('bookmarks.html', html));

    await waitForToast('0 added, 0 already there, 2 skipped (invalid address).');
    expect(store().resources).toHaveLength(0);
  });

  it('refuses an import that could not be saved into an unreadable library', async () => {
    rust.on('library_load', () => ipcReject('storage', 'library.json is locked'));
    await renderApp();
    await openImportTab();
    await chooseFile(textFile('bookmarks.html', NETSCAPE_HTML));

    await waitForToast('Your library file cannot be read, so nothing was imported');
    expect(store().resources).toHaveLength(0);
  });

  it('reads a Chromium Bookmarks JSON file and converts its WebKit dates', async () => {
    await renderApp();
    await openImportTab();
    await chooseFile(textFile('Bookmarks.json', CHROME_JSON, 'application/json'));

    await waitFor(() => expect(store().resources).toHaveLength(2));
    expect(byTitle('Vite')?.createdAt).toBe(1_700_000_000_000);
    expect(byTitle('Vitest')?.folderPath).toEqual(['Bookmarks bar', 'Tooling']);
    expect(byTitle('Vitest')?.tags).toEqual(['tooling']);
    expect(byTitle('Not a link')).toBeUndefined();
  });

  it('merges an import into existing records instead of duplicating them', async () => {
    // A record whose title is just the host: the import may improve it.
    seedLibrary([makeResource({ url: 'https://vite.dev/', title: 'vite.dev', tags: ['build'] })]);
    await renderApp();
    await openImportTab();
    await chooseFile(textFile('Bookmarks.json', CHROME_JSON, 'application/json'));

    await waitFor(() => expect(store().resources).toHaveLength(2));
    await waitForToast('1 added, 1 already there, 1 skipped (invalid address).');
    const vite = store().resources.find((r) => r.url === 'https://vite.dev/');
    expect(vite?.title).toBe('Vite');
    expect(vite?.tags).toEqual(['build']);
  });

  it('offers to analyze the new records right after the import', async () => {
    await renderApp();
    await openImportTab();
    await chooseFile(textFile('bookmarks.html', NETSCAPE_HTML));

    expect(
      await screen.findByText('3 new bookmarks were imported. Analyze them now?'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start analysis' })).toBeInTheDocument();
  });

  it('withdraws the invitation once an analysis starts and keeps it away after a cancel', async () => {
    const rust = mockRust({ analyze_url: () => new Promise(() => undefined) });
    await renderApp();
    await openImportTab();
    await chooseFile(textFile('bookmarks.html', NETSCAPE_HTML));
    const invite = '3 new bookmarks were imported. Analyze them now?';
    await screen.findByText(invite);

    // Started from elsewhere (HUD, health page), not only from the invitation's own button.
    act(() => void startEnrichment());
    await waitFor(() => expect(screen.queryByText(invite)).toBeNull());
    await waitFor(() => expect(rust.countOf('analyze_url')).toBeGreaterThan(0));

    act(() => cancelEnrichment());
    await waitFor(() => expect(store().jobs.enrich?.state).toBe('cancelled'));
    expect(screen.queryByText(invite)).toBeNull();
  });

  it('says which file to pick instead of "unexpected error" for the wrong JSON', async () => {
    await renderApp();
    await openImportTab();
    await chooseFile(textFile('Bookmarks.json', '{"not":"a bookmarks file"}', 'application/json'));

    await waitForToast('is not a browser bookmark export');
    expect(store().resources).toHaveLength(0);
  });

  it('separates an empty file from one whose bookmarks are all already saved', async () => {
    await renderApp();
    await openImportTab();
    await chooseFile(textFile('Empty.html', '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p></DL>'));
    await waitForToast('No bookmarks were found in this file.');

    const clean =
      '<DL><p><DT><A HREF="https://tokio.rs/">Tokio</A><DT><A HREF="https://react.dev/">React</A></DL>';
    await chooseFile(textFile('Bookmarks.html', clean));
    await waitForToast('2 added');
    await chooseFile(textFile('Bookmarks.html', clean));
    await waitForToast('Every bookmark here is already in your library.');
  });

  it('keeps the UI painted while a large file is parsed in chunks', async () => {
    const rows = Array.from(
      { length: 1200 },
      (_, i) => `<DT><A HREF="https://site-${i}.example.com/" ADD_DATE="1700000000">Site ${i}</A>`,
    ).join('\n');
    const big = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>\n${rows}\n</DL><p>`;

    const busyDuringParse: boolean[] = [];
    const yieldSpy = vi.fn(() => {
      busyDuringParse.push(document.body.textContent?.includes('Importing…') ?? false);
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    (globalThis as { scheduler?: { yield: () => Promise<void> } }).scheduler = {
      yield: yieldSpy,
    };

    await renderApp();
    await openImportTab();
    await chooseFile(textFile('big.html', big));

    await waitFor(() => expect(store().resources).toHaveLength(1200), { timeout: 15_000 });
    // 1200 entries / 500 per chunk: the parser handed control back twice.
    expect(yieldSpy).toHaveBeenCalledTimes(2);
    expect(busyDuringParse.every(Boolean)).toBe(true);
  }, 20_000);
});
