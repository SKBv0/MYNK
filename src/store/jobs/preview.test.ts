import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const persistence = vi.hoisted(() => ({ writeBlocked: false }));
vi.mock('../persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence')>();
  return { ...actual, isLibraryWriteBlocked: () => persistence.writeBlocked };
});

import { mockRust, stopRust, type RustMock } from '../../test/ipc';
import { useAppStore } from '../index';
import { createResource } from '../model';
import type { SnapshotResult } from '../../services/ipcTypes';
import { initSnapshotDir, resetSnapshotDirForTests, snapshotSrc } from '../../services/snapshots';
import {
  cancelPreviewCapture,
  resetLibraryWithMedia,
  resetPreviewForTests,
  startPreviewCapture,
} from './preview';

const PRISTINE = useAppStore.getState();
let rust: RustMock;

const seedOne = () => {
  const resource = createResource({ url: 'https://example.com/a' });
  if (!resource) throw new Error('fixture');
  useAppStore.setState({ resources: [{ ...resource, media: { snapshotFile: 'a.png' } }] });
};

beforeEach(() => {
  useAppStore.setState(PRISTINE, true);
  resetPreviewForTests();
  persistence.writeBlocked = false;
  rust = mockRust();
});

afterEach(() => {
  resetPreviewForTests();
  stopRust();
});

describe('resetLibraryWithMedia', () => {
  it('wipes the library data and every stored file', async () => {
    seedOne();
    useAppStore.getState().setSnapshotCacheBytes(4096);
    rust.on('reset_snapshots', () => 7);
    const deleted = resetLibraryWithMedia();
    expect(useAppStore.getState().resources).toEqual([]);
    expect(await deleted).toEqual({ state: 'done', deletedFiles: 7 });
    expect(rust.countOf('reset_snapshots')).toBe(1);
    expect(useAppStore.getState().snapshotCacheBytes).toBe(0);
  });

  it('does nothing while the library file cannot be read', async () => {
    seedOne();
    persistence.writeBlocked = true;
    expect(await resetLibraryWithMedia()).toEqual({ state: 'blocked' });
    // Otherwise the previews would be gone while library.json still points at them.
    expect(useAppStore.getState().resources).toHaveLength(1);
    expect(rust.countOf('reset_snapshots')).toBe(0);
  });

  it('reports files it could not remove apart from the wiped data', async () => {
    seedOne();
    rust.on('reset_snapshots', () => {
      throw { kind: 'storage', message: 'in use' };
    });
    const outcome = await resetLibraryWithMedia();
    expect(outcome.state).toBe('filesFailed');
    expect(useAppStore.getState().resources).toEqual([]);
  });
});

describe('cancelling preview capture', () => {
  it('stops the capture in flight and counts it as cancelled, not failed', async () => {
    const [a, b] = ['https://example.com/a', 'https://example.com/b'].map((url) => {
      const resource = createResource({ url });
      if (!resource) throw new Error('fixture');
      return resource;
    });
    if (!a || !b) throw new Error('fixture');
    useAppStore.setState({ resources: [{ ...a, media: { snapshotFile: 'old.png' } }, b] });
    let stop: (() => void) | undefined;
    rust.on(
      'capture_snapshot',
      () =>
        new Promise<SnapshotResult>((_resolve, reject) => {
          stop = () => reject({ kind: 'cancelled', message: 'The capture was cancelled.' });
        }),
    );
    rust.on('cancel_snapshot_captures', () => {
      stop?.();
      return null;
    });

    const run = startPreviewCapture([a.id, b.id]);
    await vi.waitFor(() => expect(rust.countOf('capture_snapshot')).toBe(1));
    expect(useAppStore.getState().busy.preview).toEqual([a.id]);

    cancelPreviewCapture();
    await run;

    expect(rust.countOf('cancel_snapshot_captures')).toBe(1);
    expect(rust.countOf('capture_snapshot')).toBe(1);
    const state = useAppStore.getState();
    expect(state.jobs.preview).toMatchObject({ state: 'cancelled', failed: 0 });
    expect(state.busy.preview).toEqual([]);
    expect(state.resources[0]?.media.snapshotFile).toBe('old.png');
    await vi.waitFor(() =>
      expect(useAppStore.getState().toasts.map((toast) => toast.message)).toContain(
        'Preview run cancelled: 0 taken, 0 protected, 0 failed.',
      ),
    );
  });
});

describe('single preview capture', () => {
  it('gives a re-captured file under the same name a new URL and record', async () => {
    seedOne();
    const before = useAppStore.getState().resources[0];
    rust.on('get_snapshot_dir', () => '/data/snapshots');
    rust.on('capture_snapshot', (): SnapshotResult => ({ kind: 'image', fileName: 'a.png' }));
    resetSnapshotDirForTests();
    await initSnapshotDir();
    const oldSrc = snapshotSrc('a.png');

    await startPreviewCapture([before?.id ?? '']);

    const after = useAppStore.getState().resources[0];
    expect(after?.media.snapshotFile).toBe('a.png');
    // Memoized preview lists key on the record, and the webview caches by URL.
    expect(after).not.toBe(before);
    expect(snapshotSrc('a.png')).not.toBe(oldSrc);
    expect(rust.countOf('delete_snapshots')).toBe(0);
    resetSnapshotDirForTests();
  });

  it('reports a failed capture as failed in the HUD, not only in the toast', async () => {
    seedOne();
    const id = useAppStore.getState().resources[0]?.id ?? '';
    rust.on('capture_snapshot', (): SnapshotResult => ({
      kind: 'error',
      reason: 'captureTimeout',
    }));

    await startPreviewCapture([id]);

    expect(useAppStore.getState().jobs.preview).toMatchObject({
      state: 'done',
      total: 1,
      done: 1,
      failed: 1,
    });
  });
});
