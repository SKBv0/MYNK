import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { info as pluginLogInfo } from '@tauri-apps/plugin-log';
import { ipcReject, mockRust, stopRust, type RustMock } from '../../test/ipc';
import type { AnalyzeResult, InboxEntry, InboxFile } from '../../services/ipcTypes';
import { createResource } from '../model';
import { makeResource } from '../../test/fixtures';
import {
  __resetPersistenceForTests,
  hydrateStore,
  SAVE_FAILURE_LIMIT,
  isSaveFailing,
} from '../persistence';
import { useAppStore } from '../index';
import { resetEnrichmentForTests } from './enrich';
import { drainInboxNow, resetInboxForTests, startInboxWatch, toImportedBookmark } from './inbox';

vi.mock('@tauri-apps/plugin-log', () => ({
  info: vi.fn(() => Promise.resolve()),
  warn: vi.fn(() => Promise.resolve()),
  error: vi.fn(() => Promise.resolve()),
}));

const PRISTINE = useAppStore.getState();

const ANALYSIS: AnalyzeResult = {
  title: 'Analysed',
  description: 'A summary.',
  categoryId: 'development',
  tags: ['rust'],
  summary: ['One line.'],
  insufficientContent: false,
  confidence: 0.9,
  finalUrl: 'https://example.com/',
};

const entry = (url: string, patch: Partial<InboxEntry> = {}): InboxEntry => ({
  url,
  tags: ['rust'],
  source: 'mcp:claude-code',
  createdAt: 1_757_000_000_000,
  ...patch,
});

let fileSequence = 0;
/** An inbox entry as it comes back from `peek_agent_inbox`, with the file it lives in. */
const file = (url: string, patch: Partial<InboxEntry> = {}): InboxFile => {
  fileSequence += 1;
  return {
    name: `1757000000000-0000000${fileSequence}.json`,
    entry: entry(url, patch),
  };
};

const toasts = () => useAppStore.getState().toasts.map((toast) => toast.message);

/** Names passed to every `ack_agent_inbox` call, flattened. */
const acked = (mock: RustMock): string[] =>
  mock.argsOf('ack_agent_inbox').flatMap((args) => args.names as string[]);

let rust: RustMock;

beforeEach(() => {
  useAppStore.setState(PRISTINE, true);
  __resetPersistenceForTests();
  resetInboxForTests();
  resetEnrichmentForTests();
  fileSequence = 0;
  vi.mocked(pluginLogInfo).mockClear();
  rust = mockRust({ analyze_url: () => ANALYSIS });
});

afterEach(() => {
  resetInboxForTests();
  resetEnrichmentForTests();
  __resetPersistenceForTests();
  stopRust();
  vi.restoreAllMocks();
});

describe('inbox entry mapping', () => {
  it('maps an entry to the importer’s shape', () => {
    expect(
      toImportedBookmark(
        entry('https://tokio.rs/', {
          title: 'Tokio',
          note: 'async runtime',
          tags: ['rust', 'async'],
        }),
      ),
    ).toEqual({
      url: 'https://tokio.rs/',
      title: 'Tokio',
      folderPath: [],
      tags: ['rust', 'async'],
      addedAt: 1_757_000_000_000,
      description: 'async runtime',
    });
  });

  it('leaves a missing title and note out instead of storing empty values', () => {
    const item = toImportedBookmark(entry('https://tokio.rs/'));
    expect(item.title).toBe('');
    expect('description' in item).toBe(false);
  });
});

describe('emptying the agent inbox', () => {
  it('imports what the agents left, stores it and only then acknowledges the files', async () => {
    const files = [
      file('https://doc.rust-lang.org/book/', { title: 'The Book' }),
      file('https://tokio.rs/', { title: 'Tokio' }),
    ];
    rust.on('peek_agent_inbox', () => files);
    await hydrateStore();

    const outcome = await drainInboxNow();

    expect(outcome).toEqual({ drained: 2, added: 2, merged: 0, unchanged: 0, skipped: 0 });
    expect(useAppStore.getState().resources.map((r) => r.url)).toEqual([
      'https://doc.rust-lang.org/book/',
      'https://tokio.rs/',
    ]);
    expect(toasts().join('\n')).toContain('2 bookmarks added by your agents.');
    // The library was written before the files were given up.
    expect(rust.countOf('library_save')).toBeGreaterThan(0);
    expect(acked(rust)).toEqual(files.map((f) => f.name));
    await vi.waitFor(() => expect(rust.countOf('analyze_url')).toBe(2));
  });

  it('puts what the agents added above the bookmarks already there', async () => {
    useAppStore.setState({ resources: [makeResource({ url: 'https://old.example.com/' })] });
    rust.on('peek_agent_inbox', () => [file('https://tokio.rs/', { title: 'Tokio' })]);
    await hydrateStore();

    await drainInboxNow();

    expect(useAppStore.getState().resources.map((r) => r.url)).toEqual([
      'https://tokio.rs/',
      'https://old.example.com/',
    ]);
  });

  it('keeps the title and note the agent gave through the analysis that follows', async () => {
    rust.on('peek_agent_inbox', () => [
      file('https://example.com/', { title: 'Agent added page', note: 'from mcp cli' }),
      file('https://tokio.rs/'),
    ]);
    await hydrateStore();

    await drainInboxNow();
    await vi.waitFor(() =>
      expect(useAppStore.getState().resources.every((r) => r.ai.status === 'ok')).toBe(true),
    );

    const [noted, bare] = useAppStore.getState().resources;
    expect(noted).toMatchObject({
      title: 'Agent added page',
      titleEditedByUser: true,
      description: 'from mcp cli',
      summary: ['One line.'],
    });
    // Without a title or note from the agent, the analysis fills both.
    expect(bare).toMatchObject({ title: 'Analysed', description: 'A summary.' });
    expect(bare?.titleEditedByUser).toBeUndefined();
  });

  it('merges a bookmark that is already in the library instead of adding it twice', async () => {
    const existing = createResource({ url: 'https://tokio.rs/', title: 'Tokio' });
    if (!existing) throw new Error('fixture');
    useAppStore.setState({ resources: [existing] });
    rust.on('peek_agent_inbox', () => [
      file('https://tokio.rs/', { title: 'Tokio' }),
      file('https://doc.rust-lang.org/book/', { title: 'The Book' }),
    ]);
    await hydrateStore();

    const outcome = await drainInboxNow();

    expect(outcome).toEqual({ drained: 2, added: 1, merged: 1, unchanged: 0, skipped: 0 });
    expect(useAppStore.getState().resources).toHaveLength(2);
    expect(toasts().join('\n')).toContain('1 bookmark added by your agents.');
    // Only the added record is analyzed.
    await vi.waitFor(() => expect(rust.countOf('analyze_url')).toBe(1));
    expect(rust.argsOf('analyze_url')[0]?.url).toBe('https://doc.rust-lang.org/book/');
  });

  it('a note for an address already there replaces the AI’s description, never a note', async () => {
    const analysed = createResource({ url: 'https://tokio.rs/', title: 'Tokio' });
    const noted = createResource({ url: 'https://docs.rs/', title: 'Docs' });
    if (!analysed || !noted) throw new Error('fixture');
    useAppStore.setState({
      resources: [
        { ...analysed, description: 'What the model wrote.', descriptionByAi: true },
        { ...noted, description: 'First note.' },
      ],
    });
    rust.on('peek_agent_inbox', () => [
      file('https://tokio.rs/', { note: 'Async runtime we use in prod.' }),
      file('https://docs.rs/', { note: 'Second note.' }),
    ]);
    await hydrateStore();

    await drainInboxNow();

    const byUrl = Object.fromEntries(
      useAppStore.getState().resources.map((r) => [r.url, r] as const),
    );
    expect(byUrl['https://tokio.rs/']?.description).toBe('Async runtime we use in prod.');
    expect(byUrl['https://tokio.rs/']?.descriptionByAi).toBeUndefined();
    expect(byUrl['https://docs.rs/']?.description).toBe('First note.');
  });

  it('analyzes only what the agents added, not records added while the import yielded', async () => {
    rust.on('peek_agent_inbox', () => [file('https://tokio.rs/', { title: 'Tokio' })]);
    await hydrateStore();
    const importBookmarks = useAppStore.getState().importBookmarks;
    useAppStore.setState({
      importBookmarks: async (items, options) => {
        // A typed link (or another import) can land while a large library import yields.
        const result = await importBookmarks(items, options);
        useAppStore.getState().addResource({ url: 'https://typed.example.com/' });
        return result;
      },
    });

    await drainInboxNow();

    expect(useAppStore.getState().resources).toHaveLength(2);
    await vi.waitFor(() => expect(useAppStore.getState().jobs.enrich?.state).toBe('done'));
    expect(rust.argsOf('analyze_url').map((args) => args.url)).toEqual(['https://tokio.rs/']);
  });

  it('says nothing and changes nothing for an empty inbox', async () => {
    expect(await drainInboxNow()).toEqual({
      drained: 0,
      added: 0,
      merged: 0,
      unchanged: 0,
      skipped: 0,
    });
    expect(toasts()).toEqual([]);
    expect(rust.countOf('ack_agent_inbox')).toBe(0);
    expect(rust.countOf('analyze_url')).toBe(0);
  });

  it('never navigates away when the AI is unset: the analysis it starts is a background run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rust.on('peek_agent_inbox', () => [file('https://tokio.rs/', { title: 'Tokio' })]);
    rust.on('analyze_url', () => {
      throw { kind: 'network', code: 'ollamaUnreachable', message: 'connection refused' };
    });
    await hydrateStore();
    useAppStore.setState({ aiSetupNotice: { reason: 'keyring', targets: 'all' } });

    await drainInboxNow();
    await vi.waitFor(() =>
      expect(toasts().join('\n')).toContain('Choose an AI model to analyze your bookmarks.'),
    );

    const state = useAppStore.getState();
    expect(state.page).toBe('library');
    // An open notice stays: a background run neither dismisses nor replaces it.
    expect(state.aiSetupNotice).toEqual({ reason: 'keyring', targets: 'all' });
  });

  it('reports a failed read to the log only, so a poll cannot spam the user', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rust.on('peek_agent_inbox', () => ipcReject('storage', 'the inbox could not be read'));

    expect(await drainInboxNow()).toEqual({
      drained: 0,
      added: 0,
      merged: 0,
      unchanged: 0,
      skipped: 0,
    });
    expect(toasts()).toEqual([]);
    expect(logged).toHaveBeenCalled();
  });

  it('never reads the inbox while the library cannot be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A library that couldn't be read must not consume the inbox entries.
    rust.on('library_load', () => ipcReject('storage', 'the library file is in use'));
    await hydrateStore();

    expect(await drainInboxNow()).toEqual({
      drained: 0,
      added: 0,
      merged: 0,
      unchanged: 0,
      skipped: 0,
    });
    startInboxWatch({});
    expect(rust.countOf('peek_agent_inbox')).toBe(0);
  });

  it('does not start the watch when hydration failed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    startInboxWatch({ libraryLoaded: false });
    expect(rust.countOf('peek_agent_inbox')).toBe(0);
  });

  it('reads once on start and again when the window becomes visible', async () => {
    startInboxWatch({ libraryLoaded: true });
    await vi.waitFor(() => expect(rust.countOf('peek_agent_inbox')).toBe(1));
    // Overlapping calls share one pass, so the first has to settle before the next can start.
    await new Promise((resolve) => setTimeout(resolve, 0));

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(rust.countOf('peek_agent_inbox')).toBe(2));

    resetInboxForTests();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(rust.countOf('peek_agent_inbox')).toBe(2);
  });
});

describe('a library that cannot be saved', () => {
  it('keeps the entries in the inbox and imports them again once the save works', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = [file('https://tokio.rs/', { title: 'Tokio' })];
    rust.on('peek_agent_inbox', () => pending);
    rust.on('library_save', () => ipcReject('storage', 'library.json is locked'));
    await hydrateStore();

    const failed = await drainInboxNow();

    expect(failed).toEqual({ drained: 0, added: 1, merged: 0, unchanged: 0, skipped: 0 });
    expect(rust.countOf('ack_agent_inbox')).toBe(0);
    expect(warned.mock.calls.flat().join(' ')).toContain('left in the inbox');
    expect(useAppStore.getState().resources).toHaveLength(1);

    // Same file, second pass: merges by canonical URL instead of duplicating.
    rust.on('library_save', () => null);
    const stored = await drainInboxNow();

    expect(stored.drained).toBe(1);
    expect(stored.added).toBe(0);
    expect(acked(rust)).toEqual([pending[0]?.name]);
    expect(useAppStore.getState().resources).toHaveLength(1);
  });

  it('stops reading the inbox at all once the writes keep failing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    rust.on('peek_agent_inbox', () => [file('https://tokio.rs/', { title: 'Tokio' })]);
    rust.on('library_save', () => ipcReject('storage', 'library.json is locked'));
    await hydrateStore();

    for (let attempt = 0; attempt < SAVE_FAILURE_LIMIT; attempt += 1) {
      expect(isSaveFailing()).toBe(false);
      await drainInboxNow();
    }

    expect(isSaveFailing()).toBe(true);
    const peeks = rust.countOf('peek_agent_inbox');
    expect(await drainInboxNow()).toEqual({
      drained: 0,
      added: 0,
      merged: 0,
      unchanged: 0,
      skipped: 0,
    });
    expect(rust.countOf('peek_agent_inbox')).toBe(peeks);
    expect(rust.countOf('ack_agent_inbox')).toBe(0);
  });
});

describe('the log', () => {
  it('writes the import summary into the log file, not just the console', async () => {
    rust.on('peek_agent_inbox', () => [
      file('https://tokio.rs/', { title: 'Tokio' }),
      file('https://doc.rust-lang.org/book/', { title: 'The Book', source: 'cli' }),
    ]);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await hydrateStore();

    await drainInboxNow();

    const logged = vi
      .mocked(pluginLogInfo)
      .mock.calls.map((call) => call[0])
      .join('\n');
    expect(logged).toContain('mcp:claude-code');
    expect(logged).toContain('cli');
    expect(logged).toContain('added 2');
    expect(logged).toContain('2 entries from');
  });

  it('counts a single entry in the singular', async () => {
    rust.on('peek_agent_inbox', () => [file('https://tokio.rs/', { title: 'Tokio' })]);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.mocked(pluginLogInfo).mockClear();
    await hydrateStore();

    await drainInboxNow();

    const logged = vi
      .mocked(pluginLogInfo)
      .mock.calls.map((call) => call[0])
      .join('\n');
    expect(logged).toContain('agent inbox: 1 entry from');
    expect(logged).not.toContain('1 entries');
  });
});
