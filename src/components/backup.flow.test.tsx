import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ipcReject, mockRust, stopRust, type RustMock } from '../test/ipc';
import { renderApp, resetApp, seedLibrary, store, waitForToast } from '../test/app';
import { textFile } from '../test/dom';
import { NOW, makeCollection, makeResource } from '../test/fixtures';
import { backupToJson, parseBackup } from '../lib/export';
import type { Resource } from '../types';
import { nth } from '../test/assert';

let rust: RustMock;

const LOCAL = makeResource({
  url: 'https://local.example.com/',
  title: 'Local only',
  folderPath: ['Bookmarks bar', 'Dev'],
  tags: ['dev'],
  description: 'Kept on this machine',
});
const SHARED = makeResource({ url: 'https://shared.example.com/', title: 'In both' });
const REMOTE = makeResource({ url: 'https://remote.example.com/', title: 'Backup only' });

const backupJson = () =>
  backupToJson(
    {
      resources: [SHARED, REMOTE],
      collections: [makeCollection({ name: 'From backup', keywords: ['backup'] })],
      chats: { [SHARED.id]: [{ id: 'm1', role: 'user', content: 'hi', createdAt: NOW }] },
    },
    new Date(NOW),
  );

const openSettings = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  return screen.findByText('Export and back up', { selector: 'h2' });
};

const chooseBackup = async (json: string) => {
  const input = await screen.findByTestId('backup-file-input');
  fireEvent.change(input, { target: { files: [textFile('mynk-backup.json', json)] } });
};

const titles = (): string[] =>
  store()
    .resources.map((r: Resource) => r.title)
    .sort();

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  stopRust();
});

describe('export', () => {
  it('writes a JSON backup that can be read back', async () => {
    rust.on('export_library', () => 'C:\\Downloads\\mynk-2026-03-15.json');
    seedLibrary([LOCAL, SHARED], [makeCollection({ name: 'Dev', keywords: ['dev'] })]);
    await renderApp();
    await openSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Full backup (JSON)' }));

    await waitFor(() => expect(rust.countOf('export_library')).toBe(1));
    const call = nth(rust.argsOf('export_library'), 0);
    expect(call.format).toBe('json');
    expect(String(call.suggestedName)).toMatch(/^mynk-\d{4}-\d{2}-\d{2}\.json$/);

    const round = parseBackup(call.content as string);
    expect(round.resources.map((r) => r.title).sort()).toEqual(['In both', 'Local only']);
    expect(round.collections).toHaveLength(1);

    await waitForToast('Saved to C:\\Downloads\\mynk-2026-03-15.json');
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
    await waitFor(() => expect(rust.countOf('reveal_in_folder')).toBe(1));
  });

  it('writes a Netscape HTML file that keeps folders and dates', async () => {
    seedLibrary([LOCAL]);
    await renderApp();
    await openSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Browser bookmarks (HTML)' }));

    await waitFor(() => expect(rust.countOf('export_library')).toBe(1));
    const call = nth(rust.argsOf('export_library'), 0);
    expect(call.format).toBe('html');
    const html = call.content as string;
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    expect(html).toContain('<H3 ADD_DATE=');
    expect(html).toContain('>Bookmarks bar</H3>');
    expect(html).toContain('>Dev</H3>');
    expect(html).toContain(`HREF="https://local.example.com/"`);
    expect(html).toContain(`ADD_DATE="${Math.floor(LOCAL.createdAt / 1000)}"`);
    expect(html).toContain('TAGS="dev"');
  });

  it('says so instead of writing an empty file', async () => {
    await renderApp();
    await openSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Full backup (JSON)' }));

    await waitForToast('Your library is empty');
    expect(rust.countOf('export_library')).toBe(0);
  });
});

describe('restore', () => {
  it('previews the backup before anything changes and merges on confirmation', async () => {
    seedLibrary([LOCAL, SHARED]);
    await renderApp();
    await openSettings();
    await chooseBackup(backupJson());

    expect(await screen.findByText('mynk-backup.json')).toBeInTheDocument();
    expect(screen.getByText('2 bookmarks · 1 collection · 1 chat')).toBeInTheDocument();
    expect(titles()).toEqual(['In both', 'Local only']);

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Merge the backup into your library?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(store().resources).toHaveLength(3));
    expect(titles()).toEqual(['Backup only', 'In both', 'Local only']);
    expect(store().collections.map((c) => c.name)).toEqual(['From backup']);
    expect(store().chats[SHARED.id]).toHaveLength(1);
    await waitForToast('Restored: 1 added, 1 merged, 1 new collections.');
  });

  it('refuses to restore into a library file it could not read', async () => {
    rust.on('library_load', () => ipcReject('storage', 'library.json is locked'));
    await renderApp();
    await openSettings();
    await chooseBackup(backupJson());

    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Merge the backup into your library?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));

    await waitForToast('Your library file cannot be read, so nothing was imported');
    expect(store().resources).toHaveLength(0);
  });

  it('replaces the library when that mode is chosen and confirmed', async () => {
    seedLibrary([LOCAL]);
    await renderApp();
    await openSettings();
    await chooseBackup(backupJson());

    fireEvent.click(await screen.findByRole('radio', { name: 'Replace my library with it' }));
    expect(
      screen.getByText(
        'Your current bookmarks, collections and chats are deleted and replaced by the backup.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Delete your library and replace it with the backup?',
    });
    expect(within(dialog).getByText(/This cannot be undone/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace library' }));

    await waitFor(() => expect(titles()).toEqual(['Backup only', 'In both']));
    await waitForToast('Restored: 2 added, 0 merged, 1 new collections.');
  });

  it('lets the user back out of the preview', async () => {
    seedLibrary([LOCAL]);
    await renderApp();
    await openSettings();
    await chooseBackup(backupJson());

    const preview = await screen.findByText('mynk-backup.json');
    fireEvent.click(nth(screen.getAllByRole('button', { name: 'Cancel' }), 0));

    await waitFor(() => expect(preview).not.toBeInTheDocument());
    expect(titles()).toEqual(['Local only']);
  });

  it('explains what is wrong with a file it cannot restore', async () => {
    seedLibrary([LOCAL]);
    await renderApp();
    await openSettings();

    await chooseBackup('{ not json');
    await waitForToast('Could not restore: The file is not valid JSON.');

    await chooseBackup(JSON.stringify({ app: 'something-else', resources: [] }));
    await waitForToast('Could not restore: This is not a MYNK backup file.');

    await chooseBackup(JSON.stringify({ app: 'mynk', version: 99, resources: [] }));
    await waitForToast('Could not restore: This backup was made by a newer version of MYNK.');

    expect(titles()).toEqual(['Local only']);
  });
});
