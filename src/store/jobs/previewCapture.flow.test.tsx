import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { SnapshotResult } from '../../services/ipcTypes';
import { deferred, mockRust, stopRust, type RustMock } from '../../test/ipc';
import {
  flush,
  hasToast,
  renderApp,
  resetApp,
  seedLibrary,
  store,
  waitForToast,
} from '../../test/app';
import { imageFile } from '../../test/dom';
import { makeResource } from '../../test/fixtures';
import {
  MAX_UPLOAD_BYTES,
  cancelPreviewCapture,
  previewFailureMessage,
  startPreviewCapture,
} from './preview';
import { nth } from '../../test/assert';

let rust: RustMock;

const A = 'https://a.example.com/';
const B = 'https://b.example.com/';

const openHealthPage = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^Link health/ }));
  return screen.findByRole('heading', { name: 'Link health', level: 1 });
};

const mediaOf = (url: string) => store().resources.find((r) => r.url === url)?.media;

/** Stubs the OS file picker: answers the detached `<input type="file">` click jsdom ignores. */
const stubFilePicker = (file: File | null) => {
  const realClick = HTMLInputElement.prototype.click;
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
    this: HTMLInputElement,
  ) {
    if (this.type !== 'file' || this.isConnected) {
      realClick.call(this);
      return;
    }
    if (file) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] });
      this.onchange?.(new Event('change'));
    } else {
      this.oncancel?.(new Event('cancel'));
    }
  });
};

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  vi.restoreAllMocks();
  stopRust();
});

describe('preview capture', () => {
  it('captures the missing previews and stores only the file name', async () => {
    const shots: Record<string, SnapshotResult> = {
      [A]: { kind: 'image', fileName: 'a.png' },
      [B]: { kind: 'image', fileName: 'b.png' },
    };
    rust.on('capture_snapshot', (args) => shots[args.url as string]);
    seedLibrary([makeResource({ url: A }), makeResource({ url: B })]);
    await renderApp();
    await openHealthPage();

    fireEvent.click(screen.getByRole('button', { name: 'Take 2 previews' }));

    await waitFor(() => expect(mediaOf(A)?.snapshotFile).toBe('a.png'));
    await waitFor(() => expect(mediaOf(B)?.snapshotFile).toBe('b.png'));
    await waitForToast('Previews: 2 taken, 0 protected, 0 failed.');
    // Nothing but the file name ever reaches the store.
    expect(JSON.stringify(mediaOf(A))).not.toContain('/');
  });

  it('replaces an existing screenshot from the card and deletes the file it replaced', async () => {
    rust.on('capture_snapshot', () => ({ kind: 'image', fileName: 'new.png' }));
    seedLibrary([makeResource({ url: A, title: 'Card', media: { snapshotFile: 'old.png' } })]);
    await renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh preview' }));

    await waitFor(() => expect(mediaOf(A)?.snapshotFile).toBe('new.png'));
    await waitForToast('Preview updated.');
    await waitFor(() => expect(rust.countOf('delete_snapshots')).toBe(1));
    expect(nth(rust.argsOf('delete_snapshots'), 0)).toEqual({ fileNames: ['old.png'] });
  });

  it('records a verification wall instead of a screenshot', async () => {
    rust.on('capture_snapshot', () => ({ kind: 'challenge', reason: 'cloudflare' }));
    seedLibrary([makeResource({ url: A, title: 'Walled' })]);
    await renderApp();
    await openHealthPage();

    fireEvent.click(screen.getByRole('button', { name: 'Take 1 preview' }));

    await waitFor(() => expect(mediaOf(A)?.challenge).toBe(true));
    await waitForToast('asks for human verification');
    // The row offers the upload path instead.
    expect(await screen.findByText('Verification page')).toBeInTheDocument();
  });

  it('stops the queue and warns once when the capture runtime is missing', async () => {
    rust.on('capture_snapshot', () => ({ kind: 'runtimeMissing' }));
    seedLibrary([makeResource({ url: A }), makeResource({ url: B })]);
    await renderApp();
    await openHealthPage();

    fireEvent.click(screen.getByRole('button', { name: 'Take 2 previews' }));

    await waitForToast('Taking previews needs Chrome or Edge');
    // The second bookmark was never attempted: every capture would fail the same way.
    await waitFor(() => expect(store().jobs.preview?.state).toBe('cancelled'));
    expect(rust.countOf('capture_snapshot')).toBe(1);
    // The untried bookmark is not a failure: the run was stopped, not finished.
    await waitForToast('Preview run cancelled: 0 taken, 0 protected, 0 failed.');
    expect(hasToast('0 captured, 0 protected, 2 failed')).toBe(false);

    // Dismiss it, run again: the warning is a once-per-session message.
    store().toasts.forEach((t) => store().dismissToast(t.id));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Take 2 previews' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Take 2 previews' }));
    await waitFor(() => expect(rust.countOf('capture_snapshot')).toBe(2));
    await waitFor(() => expect(store().jobs.preview?.state).toBe('cancelled'));
    expect(
      store().toasts.some((t) => t.message.includes('Taking previews needs Chrome or Edge')),
    ).toBe(false);
  });

  it('reports what was captured when the user stops the run', async () => {
    const pending = deferred<SnapshotResult>();
    rust.on('capture_snapshot', () => pending.promise);
    seedLibrary([makeResource({ url: A }), makeResource({ url: B })]);
    await renderApp();
    await openHealthPage();

    fireEvent.click(screen.getByRole('button', { name: 'Take 2 previews' }));
    await waitFor(() => expect(rust.countOf('capture_snapshot')).toBe(1));

    // What the "Stop capturing" button does (the HUD is covered by the health flow test).
    cancelPreviewCapture();
    // The capture that was already running still delivers its screenshot.
    pending.resolve({ kind: 'image', fileName: 'a.png' });

    await waitFor(() => expect(mediaOf(A)?.snapshotFile).toBe('a.png'));
    await waitForToast('Preview run cancelled: 1 taken, 0 protected, 0 failed.');
    // The bookmark that never ran is not counted as failed.
    expect(hasToast('1 failed')).toBe(false);
    expect(rust.countOf('capture_snapshot')).toBe(1);
  });

  it('accepts a preview image chosen by the user', async () => {
    rust.on('save_uploaded_preview', () => 'uploaded-1.png');
    seedLibrary([makeResource({ url: A, title: 'Needs an image' })]);
    await renderApp();
    await openHealthPage();
    stubFilePicker(imageFile('shot.png', 'image/png', 2048));

    fireEvent.click(nth(screen.getAllByRole('button', { name: 'Upload' }), 0));

    await waitFor(() => expect(mediaOf(A)?.uploadedFile).toBe('uploaded-1.png'));
    await waitForToast('Preview image saved.');
    expect(rust.countOf('save_uploaded_preview')).toBe(1);
  });

  it('says the file is not a usable image when Rust rejects its content', async () => {
    rust.on('save_uploaded_preview', () => {
      throw { kind: 'invalidInput', message: 'image content does not match its extension' };
    });
    seedLibrary([makeResource({ url: A })]);
    await renderApp();
    await openHealthPage();
    // Named .png and typed image/png, but Rust finds text inside.
    stubFilePicker(imageFile('notes.png', 'image/png', 2048));

    fireEvent.click(nth(screen.getAllByRole('button', { name: 'Upload' }), 0));

    await waitForToast('This file cannot be used.');
    expect(hasToast('AI provider')).toBe(false);
    expect(hasToast('image content does not match')).toBe(false);
    expect(mediaOf(A)?.uploadedFile).toBeUndefined();
  });

  it('refuses an unsupported image type and one that is too large', async () => {
    seedLibrary([makeResource({ url: A })]);
    await renderApp();
    await openHealthPage();

    stubFilePicker(imageFile('anim.gif', 'image/gif', 1024));
    fireEvent.click(nth(screen.getAllByRole('button', { name: 'Upload' }), 0));
    await waitForToast('Only PNG, JPEG or WebP images can be used.');
    expect(rust.countOf('save_uploaded_preview')).toBe(0);

    vi.restoreAllMocks();
    stubFilePicker(imageFile('huge.png', 'image/png', MAX_UPLOAD_BYTES + 1));
    fireEvent.click(nth(screen.getAllByRole('button', { name: 'Upload' }), 0));
    await waitForToast('The image is larger than 15 MB.');
    expect(rust.countOf('save_uploaded_preview')).toBe(0);
    expect(mediaOf(A)?.uploadedFile).toBeUndefined();
  });

  it('deletes the media of removed bookmarks but keeps files another bookmark uses', async () => {
    seedLibrary([
      makeResource({
        url: A,
        title: 'First',
        media: { snapshotFile: 'a.png', faviconFile: 'shared.ico' },
      }),
      makeResource({
        url: B,
        title: 'Second',
        media: { snapshotFile: 'b.png', faviconFile: 'shared.ico' },
      }),
    ]);
    await renderApp();

    const first = nth(store().resources, 0);
    store().toggleBatch(first.id);
    const dock = await screen.findByRole('toolbar', { name: 'Selection actions' });
    fireEvent.click(within(dock).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete selected bookmarks?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(store().resources).toHaveLength(1));
    await waitFor(() => expect(rust.countOf('delete_snapshots')).toBe(1));
    // `shared.ico` is still referenced by the surviving bookmark.
    expect(nth(rust.argsOf('delete_snapshots'), 0)).toEqual({ fileNames: ['a.png'] });
    await waitForToast('1 bookmark deleted.');
  });
});

describe('preview capture restarts', () => {
  it('waits for the cancelled capture before starting a new one', async () => {
    const first = deferred<SnapshotResult>();
    rust.on('capture_snapshot', () =>
      rust.countOf('capture_snapshot') === 1
        ? first.promise
        : { kind: 'image', fileName: 'second.png' },
    );
    seedLibrary([makeResource({ url: A })]);
    await renderApp();
    const id = nth(store().resources, 0).id;

    const run1 = startPreviewCapture([id]);
    await waitFor(() => expect(rust.countOf('capture_snapshot')).toBe(1));
    cancelPreviewCapture();
    const run2 = startPreviewCapture([id]);
    await flush();
    await flush();

    // Concurrency 1 holds across runs: no second browser while the first still captures.
    expect(rust.countOf('capture_snapshot')).toBe(1);
    first.resolve({ kind: 'image', fileName: 'first.png' });
    await run1;
    await run2;

    expect(rust.countOf('capture_snapshot')).toBe(2);
    expect(mediaOf(A)?.snapshotFile).toBe('second.png');
    expect(store().jobs.preview).toMatchObject({ state: 'done', total: 1, done: 1 });
    expect(store().busy.preview).toEqual([]);
  });

  it('starting twice at once captures each record only once', async () => {
    const gate = deferred<SnapshotResult>();
    rust.on('capture_snapshot', () => gate.promise);
    seedLibrary([makeResource({ url: A })]);
    await renderApp();
    const id = nth(store().resources, 0).id;

    const a = startPreviewCapture([id]);
    const b = startPreviewCapture([id]);
    await waitFor(() => expect(rust.countOf('capture_snapshot')).toBe(1));
    gate.resolve({ kind: 'image', fileName: 'a.png' });
    await Promise.all([a, b]);

    expect(rust.countOf('capture_snapshot')).toBe(1);
  });
});

describe('preview failure reasons', () => {
  it('translates known reason codes and never shows raw backend text', async () => {
    rust.on('capture_snapshot', (args) =>
      args.url === A
        ? { kind: 'error', reason: 'browserLaunchFailed' }
        : { kind: 'error', reason: 'C:/Users/me/chrome.exe exited: code 1' },
    );
    seedLibrary([makeResource({ url: A }), makeResource({ url: B })]);
    await renderApp();
    const ids = store().resources.map((r) => r.id);
    const a = nth(ids, 0);
    const b = nth(ids, 1);

    await startPreviewCapture([a]);
    await waitForToast('Could not take the preview: the browser could not be started');

    await startPreviewCapture([b]);
    await waitFor(() =>
      expect(store().toasts.filter((t) => t.message === 'Could not take the preview')).toHaveLength(
        1,
      ),
    );
    expect(hasToast('chrome.exe')).toBe(false);
    expect(hasToast('Users')).toBe(false);
  });

  it('falls back to the generic text for missing or unknown codes', () => {
    expect(previewFailureMessage(undefined)).toBe('Could not take the preview');
    expect(previewFailureMessage('toString')).toBe('Could not take the preview');
    expect(previewFailureMessage('captureFailed')).toBe(
      'Could not take the preview: the page could not be rendered',
    );
    store().setLang('tr');
    expect(previewFailureMessage('captureTimeout')).toBe(
      'Önizleme alınamadı: sayfa çok geç yüklendi',
    );
  });
});
