import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './index';
import { folderTags } from './slices/library';
import type { LinkHealthResult } from '../services/ipcTypes';
import { nth } from '../test/assert';

const initial = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(initial, true);
});

/** Clears the auto-dismiss timers a test's toasts would otherwise leave running. */
const dismissAllToasts = (): void => {
  for (const toast of useAppStore.getState().toasts) useAppStore.getState().dismissToast(toast.id);
};

/** Ages every record so a later `Date.now()` stamp is guaranteed to differ; returns that stamp. */
const backdate = (): number => {
  const updatedAt = Date.now() - 60_000;
  useAppStore.setState((state) => ({
    resources: state.resources.map((r) => ({ ...r, updatedAt })),
  }));
  return updatedAt;
};

const health = (url: string, patch: Partial<LinkHealthResult>): LinkHealthResult => ({
  url,
  ok: false,
  definitelyBroken: false,
  previewBlocked: false,
  errorKind: 'none',
  ...patch,
});

describe('library slice', () => {
  it('addResource returns the existing record for a canonical duplicate', () => {
    const first = useAppStore.getState().addResource({ url: 'https://www.example.com/a/' });
    const again = useAppStore.getState().addResource({ url: 'http://example.com/a#x' });
    expect(first?.duplicate).toBe(false);
    expect(again?.duplicate).toBe(true);
    expect(again?.resource.id).toBe(first?.resource.id);
    expect(useAppStore.getState().resources).toHaveLength(1);
  });

  it('strips credentials out of a url patch instead of storing them', () => {
    const added = useAppStore.getState().addResource({ url: 'https://example.com/a' });
    const id = added?.resource.id ?? '';
    useAppStore.getState().updateResource(id, { url: 'https://user:pw@example.com/b' });

    const updated = useAppStore.getState().resources.find((r) => r.id === id);
    expect(updated?.url).toBe('https://example.com/b');
    expect(updated?.url).not.toContain('pw');
  });

  it('forgets a remembered redirect when the record moves address or is removed', () => {
    const added = useAppStore.getState().addResource({ url: 'https://example.com/a' });
    const id = added?.resource.id ?? '';
    useAppStore
      .getState()
      .noteFinalUrls([{ url: 'https://example.com/a', finalUrl: 'https://example.com/final' }]);
    expect(Object.keys(useAppStore.getState().finalUrls)).toEqual(['example.com/a']);

    useAppStore.getState().updateResource(id, { url: 'https://example.com/final' });
    expect(useAppStore.getState().finalUrls).toEqual({});

    useAppStore
      .getState()
      .noteFinalUrls([{ url: 'https://example.com/final', finalUrl: 'https://example.com/z' }]);
    useAppStore.getState().removeResources([id]);
    expect(useAppStore.getState().finalUrls).toEqual({});
  });

  it('applyPreview keeps the same record when the patch changes nothing', () => {
    const added = useAppStore.getState().addResource({ url: 'https://example.com/a' });
    const id = added?.resource.id ?? '';
    useAppStore.getState().applyPreview(id, { snapshotFile: 'a.png' });
    const before = useAppStore.getState().resources;

    useAppStore.getState().applyPreview(id, { snapshotFile: 'a.png', challenge: false });
    expect(useAppStore.getState().resources).toBe(before);

    useAppStore.getState().applyPreview(id, { snapshotFile: 'b.png' });
    expect(useAppStore.getState().resources).not.toBe(before);
  });

  it('importBookmarks keeps a record the import has nothing new for, and writes nothing', async () => {
    const bookmark = { url: 'https://react.dev', title: 'React', folderPath: ['Dev'] };
    await useAppStore.getState().importBookmarks([bookmark]);
    const before = useAppStore.getState().resources;

    const outcome = await useAppStore.getState().importBookmarks([bookmark]);

    expect(outcome).toEqual({ added: 0, merged: 1, unchanged: 1, skipped: 0 });
    expect(useAppStore.getState().resources).toBe(before);
  });

  it('importBookmarks dedups by urlKey in one pass and turns folders into tags', async () => {
    useAppStore.getState().addResource({ url: 'https://react.dev', title: 'react.dev' });
    const outcome = await useAppStore.getState().importBookmarks([
      { url: 'https://react.dev/', title: 'React', folderPath: ['Bookmarks bar', 'Dev', 'JS'] },
      {
        url: 'https://rust-lang.org',
        title: 'Rust',
        folderPath: ['Bookmarks bar'],
        addedAt: 1_600_000_000_000,
      },
      { url: 'https://rust-lang.org/?utm_source=x', title: 'Rust again', folderPath: [] },
      { url: 'notaurl', title: 'bad', folderPath: [] },
    ]);
    expect(outcome).toEqual({ added: 1, merged: 2, unchanged: 1, skipped: 1 });
    const resources = useAppStore.getState().resources;
    const react = resources.find((r) => r.url.startsWith('https://react.dev'));
    expect(react?.title).toBe('React');
    expect(react?.tags).toEqual(['dev', 'js']);
    const rust = resources.find((r) => r.url.startsWith('https://rust-lang.org'));
    expect(rust?.createdAt).toBe(1_600_000_000_000);
    expect(rust?.tags).toEqual([]);
    expect(rust?.categoryId).toBe('other');
    expect(rust?.ai.status).toBe('none');
  });

  it('applyHealthResults only marks definitive failures dead and keeps state on uncertain results', () => {
    const store = useAppStore.getState();
    store.addResource({ url: 'https://dead.com' });
    store.addResource({ url: 'https://flaky.com' });
    store.addResource({ url: 'https://alive.com' });
    store.addResource({ url: 'https://walled.com' });
    useAppStore.setState((s) => ({
      resources: s.resources.map((r) =>
        r.url.includes('flaky') ? { ...r, health: { status: 'dead', checkedAt: 1 } } : r,
      ),
    }));

    const outcome = useAppStore
      .getState()
      .applyHealthResults([
        health('https://dead.com', { definitelyBroken: true, status: 404, errorKind: 'http' }),
        health('https://flaky.com', { errorKind: 'timeout' }),
        health('https://alive.com/', { ok: true, status: 200 }),
        health('https://walled.com', { ok: true, status: 403, previewBlocked: true }),
      ]);
    expect(outcome).toEqual({ dead: 1, protected: 1, uncertain: 1 });

    const byHost = (host: string) =>
      useAppStore.getState().resources.find((r) => r.url.includes(host));
    expect(byHost('dead.com')?.health.status).toBe('dead');
    expect(byHost('flaky.com')?.health).toEqual({ status: 'dead', checkedAt: 1 });
    expect(byHost('alive.com')?.health.status).toBe('alive');
    expect(byHost('walled.com')?.health.status).toBe('protected');
    expect(byHost('walled.com')?.media.previewBlocked).toBe(true);
  });

  it('keeps why a link is dead and forgets it once a check reaches the page', () => {
    const store = useAppStore.getState();
    store.addResource({ url: 'https://gone.example.com' });
    store.addResource({ url: 'https://missing.example.com' });
    store.applyHealthResults([
      health('https://gone.example.com', { definitelyBroken: true, errorKind: 'dns' }),
      health('https://missing.example.com', {
        definitelyBroken: true,
        status: 404,
        errorKind: 'http',
      }),
    ]);
    const byHost = (host: string) =>
      useAppStore.getState().resources.find((r) => r.url.includes(host));
    expect(byHost('gone')?.health).toMatchObject({ status: 'dead', errorKind: 'dns' });
    expect(byHost('gone')?.health.httpStatus).toBeUndefined();
    expect(byHost('missing')?.health).toMatchObject({ httpStatus: 404, errorKind: 'http' });

    useAppStore
      .getState()
      .applyHealthResults([health('https://gone.example.com', { ok: true, status: 200 })]);
    expect(byHost('gone')?.health).not.toHaveProperty('errorKind');
  });

  it('updateResource moves a record to a new address unless another record has it', () => {
    const store = useAppStore.getState();
    const id = store.addResource({ url: 'https://old.example.com/a' })?.resource.id as string;
    store.addResource({ url: 'https://taken.example.com/' });
    const byId = () => useAppStore.getState().resources.find((r) => r.id === id);

    useAppStore.getState().updateResource(id, { url: 'https://www.taken.example.com' });
    expect(byId()?.url).toBe('https://old.example.com/a');
    useAppStore.getState().updateResource(id, { url: 'mailto:someone@example.com' });
    expect(byId()?.url).toBe('https://old.example.com/a');

    useAppStore.getState().updateResource(id, { url: 'https://new.example.com/b/' });
    expect(byId()).toMatchObject({
      url: 'https://new.example.com/b/',
      urlKey: 'new.example.com/b',
    });
  });

  it('noteFinalUrls remembers only real moves and forgets them when a link resolves', () => {
    const note = useAppStore.getState().noteFinalUrls;
    note([
      { url: 'https://a.example.com/docs', finalUrl: 'https://a.example.com/docs/en/' },
      { url: 'http://b.example.com/', finalUrl: 'https://www.b.example.com' },
    ]);
    expect(useAppStore.getState().finalUrls).toEqual({
      'a.example.com/docs': 'https://a.example.com/docs/en/',
    });
    const before = useAppStore.getState();
    note([{ url: 'https://c.example.com/', finalUrl: undefined }]);
    expect(useAppStore.getState()).toBe(before);
    note([{ url: 'https://a.example.com/docs', finalUrl: undefined }]);
    expect(useAppStore.getState().finalUrls).toEqual({});
  });

  it('applyMediaPatches keeps the library array when no patch changes anything', () => {
    const id = useAppStore.getState().addResource({ url: 'https://example.com/m' })?.resource.id;
    if (!id) throw new Error('fixture');
    useAppStore.getState().applyMediaPatches(new Map([[id, { faviconFile: 'f.png' }]]));
    const before = useAppStore.getState().resources;

    useAppStore.getState().applyMediaPatches(new Map([[id, { faviconFile: 'f.png' }]]));
    expect(useAppStore.getState().resources).toBe(before);

    useAppStore.getState().applyMediaPatches(new Map([[id, { faviconFile: undefined }]]));
    expect(useAppStore.getState().resources[0]?.media).not.toHaveProperty('faviconFile');
  });

  it('forgets remembered redirects on a reset and on a replacing restore, not on a merge', () => {
    const remember = () =>
      useAppStore
        .getState()
        .noteFinalUrls([
          { url: 'https://a.example.com/docs', finalUrl: 'https://a.example.com/en' },
        ]);
    const backup = { exportedAt: null, resources: [], collections: [], chats: {} };

    remember();
    useAppStore.getState().restoreLibrary(backup, 'merge');
    expect(useAppStore.getState().finalUrls).not.toEqual({});
    useAppStore.getState().restoreLibrary(backup, 'replace');
    expect(useAppStore.getState().finalUrls).toEqual({});

    remember();
    useAppStore.getState().resetLibrary();
    expect(useAppStore.getState().finalUrls).toEqual({});
  });

  it('removeResources clears selection, batch, chats and pins', () => {
    const store = useAppStore.getState();
    const a = store.addResource({ url: 'https://a.com' })?.resource.id as string;
    const b = store.addResource({ url: 'https://b.com' })?.resource.id as string;
    const collection = store.createCollection({ name: 'C', description: '', keywords: [] });
    store.togglePin(collection?.id as string, a);
    store.selectResource(a);
    store.setBatch([a, b]);
    store.appendChatMessage(a, { id: 'm', role: 'user', content: 'hi', createdAt: 1 });

    const removed = useAppStore.getState().removeResources([a]);
    const state = useAppStore.getState();
    expect(removed.map((r) => r.id)).toEqual([a]);
    expect(state.selectedResourceId).toBeNull();
    expect(state.batchSelectedIds).toEqual([b]);
    expect(state.chats[a]).toBeUndefined();
    expect(state.collections[0]?.pinnedIds).toEqual([]);
  });

  it('applyAnalysis keeps a user-edited title', () => {
    const store = useAppStore.getState();
    const id = store.addResource({ url: 'https://x.com' })?.resource.id as string;
    store.updateResource(id, { title: 'My own name' }, { byUser: true });
    useAppStore.getState().applyAnalysis(id, {
      title: 'AI title',
      description: 'desc',
      categoryId: 'tools',
      tags: ['a'],
      summary: ['s'],
      insufficientContent: false,
      confidence: 0.8,
      finalUrl: 'https://x.com',
      imageUrl: 'https://x.com/og.png',
    });
    const resource = nth(useAppStore.getState().resources, 0);
    expect(resource.title).toBe('My own name');
    expect(resource.categoryId).toBe('tools');
    expect(resource.ai).toMatchObject({ status: 'ok', confidence: 0.8 });
    expect(resource.media.imageUrl).toBe('https://x.com/og.png');
  });

  it('applyAnalysis keeps the user tags when the AI fills up the tag cap', () => {
    const store = useAppStore.getState();
    const id = store.addResource({ url: 'https://tags.com' })?.resource.id as string;
    const mine = Array.from({ length: 24 }, (_, i) => `mine-${i}`);
    store.updateResource(id, { tags: mine });
    useAppStore.getState().applyAnalysis(id, {
      title: 'Tags',
      description: 'desc',
      categoryId: 'tools',
      tags: ['ai-one', 'ai-two'],
      summary: ['s'],
      insufficientContent: false,
      confidence: 0.5,
      finalUrl: 'https://tags.com',
    });
    // 24 is the cap in lib/text.ts#normalizeTags: the AI tags are the ones that get cut.
    expect(useAppStore.getState().resources[0]?.tags).toEqual(mine);
  });

  it('applyAnalysis appends AI tags after the user tags', () => {
    const store = useAppStore.getState();
    const id = store.addResource({ url: 'https://few.com' })?.resource.id as string;
    store.updateResource(id, { tags: ['mine'] });
    useAppStore.getState().applyAnalysis(id, {
      title: 'Few',
      description: 'desc',
      categoryId: 'tools',
      tags: ['ai'],
      summary: ['s'],
      insufficientContent: false,
      confidence: 0.5,
      finalUrl: 'https://few.com',
    });
    expect(useAppStore.getState().resources[0]?.tags).toEqual(['mine', 'ai']);
  });

  it('a preview that lands mid-analysis does not make the result look outdated', () => {
    const store = useAppStore.getState();
    const id = store.addResource({ url: 'https://shot.com' })?.resource.id as string;
    const baseUpdatedAt = backdate();

    useAppStore.getState().applyPreview(id, { snapshotFile: 'shot.png' });
    useAppStore.getState().applyAnalysis(
      id,
      {
        title: 'Shot',
        description: 'desc',
        categoryId: 'tools',
        tags: [],
        summary: ['s'],
        insufficientContent: false,
        confidence: 0.5,
        finalUrl: 'https://shot.com',
      },
      baseUpdatedAt,
    );

    const resource = nth(useAppStore.getState().resources, 0);
    expect(resource.categoryId).toBe('tools');
    expect(resource.summary).toEqual(['s']);
    expect(resource.media.snapshotFile).toBe('shot.png');
  });

  it('marking a favorite is not a content edit', () => {
    const store = useAppStore.getState();
    const id = store.addResource({ url: 'https://fav.com' })?.resource.id as string;
    const before = backdate();

    useAppStore.getState().toggleFavorite(id);

    const resource = nth(useAppStore.getState().resources, 0);
    expect(resource.isFavorite).toBe(true);
    expect(resource.updatedAt).toBe(before);
  });

  it('toasts are deduplicated and capped at 4', () => {
    const store = useAppStore.getState();
    store.pushToast('same', 'info');
    store.pushToast('same', 'info');
    ['a', 'b', 'c', 'd'].forEach((m) => store.pushToast(m, 'error'));
    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(4);
    expect(toasts.map((t) => t.message)).toEqual(['a', 'b', 'c', 'd']);
    toasts.forEach((t) => useAppStore.getState().dismissToast(t.id));
    expect(useAppStore.getState().toasts).toHaveLength(0);
  });

  it('overflow drops an auto-dismissing toast before a persistent warning', () => {
    const store = useAppStore.getState();
    store.pushToast('not saving', 'error', { durationMs: 0 });
    ['a', 'b', 'c', 'd', 'e'].forEach((m) => store.pushToast(m, 'info'));

    expect(useAppStore.getState().toasts.map((t) => t.message)).toEqual([
      'not saving',
      'c',
      'd',
      'e',
    ]);
    dismissAllToasts();
  });

  it('overflow keeps every persistent toast, so no standing warning is lost', () => {
    const store = useAppStore.getState();
    ['a', 'b', 'c', 'd', 'e'].forEach((m) => store.pushToast(m, 'error', { durationMs: 0 }));

    expect(useAppStore.getState().toasts.map((t) => t.message)).toEqual(['a', 'b', 'c', 'd', 'e']);
    dismissAllToasts();
  });

  it('a refreshed toast takes the new action, or none, instead of keeping the old one', () => {
    const store = useAppStore.getState();
    const run = vi.fn();
    store.pushToast('same', 'info', { action: { label: 'Show', run } });
    expect(useAppStore.getState().toasts[0]?.action?.label).toBe('Show');

    store.pushToast('same', 'info');
    expect(useAppStore.getState().toasts).toHaveLength(1);
    expect(useAppStore.getState().toasts[0]?.action).toBeUndefined();
    dismissAllToasts();
  });

  it('holding a toast keeps it on screen until the pointer leaves', () => {
    vi.useFakeTimers();
    const store = useAppStore.getState();
    const id = store.pushToast('held', 'info', { durationMs: 1000 });
    store.holdToast(id, true);
    vi.advanceTimersByTime(5000);
    expect(useAppStore.getState().toasts).toHaveLength(1);

    store.holdToast(id, false);
    vi.advanceTimersByTime(1001);
    expect(useAppStore.getState().toasts).toHaveLength(0);
    vi.useRealTimers();
  });

  it('chat threads are capped at 100 messages', () => {
    const store = useAppStore.getState();
    for (let i = 0; i < 120; i += 1) {
      store.appendChatMessage('global', {
        id: `m${i}`,
        role: 'user',
        content: `${i}`,
        createdAt: i,
      });
    }
    const thread = useAppStore.getState().chats.global;
    expect(thread).toHaveLength(100);
    expect(thread?.[0]?.content).toBe('20');
  });
});

describe('folderTags', () => {
  it('uses the last two meaningful folder names', () => {
    expect(folderTags(['Bookmarks bar', 'Dev', 'Rust', 'Async'])).toEqual(['rust', 'async']);
    expect(folderTags(['Yer İmleri Çubuğu'])).toEqual([]);
    expect(folderTags(['Other bookmarks', 'Okuma Listesi'])).toEqual(['okuma listesi']);
  });
});
