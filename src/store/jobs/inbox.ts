/**
 * Agent inbox: `mynk-mcp` drops bookmarks into `<data dir>/inbox`. `peek` reads without deleting;
 * `ack` removes files only after the import is on disk. A run never starts while
 * `isLibraryWriteBlocked()` or `isSaveFailing()`.
 */
import { ackAgentInbox, peekAgentInbox } from '../../services/agents';
import { isDesktopRuntime } from '../../services/ipc';
import type { ImportedBookmark, InboxEntry, InboxFile } from '../../services/ipcTypes';
import { reportError } from '../../lib/errors';
import { logInfo } from '../../lib/logBridge';
import { fmt } from '../../lib/text';
import { canonicalUrlKey, normalizeInputUrl } from '../../lib/url';
import { getT, useAppStore } from '../index';
import { flushPersistence, isLibraryWriteBlocked, isSaveFailing } from '../persistence';
import type { ImportOutcome } from '../slices/library';
import { startEnrichment } from './enrich';

/** How often the inbox is checked while the app is open. */
export const INBOX_POLL_MS = 10_000;

export interface InboxDrainOutcome extends ImportOutcome {
  /** Entries that were taken out of the inbox, i.e. imported *and* stored. */
  drained: number;
}

const NOTHING: InboxDrainOutcome = { drained: 0, added: 0, merged: 0, unchanged: 0, skipped: 0 };

const store = () => useAppStore.getState();

let watching = false;
let timer: ReturnType<typeof setInterval> | null = null;
/** The drain in flight, so a poll, a focus change and the button cannot overlap. */
let running: Promise<InboxDrainOutcome> | null = null;

/** Maps an inbox entry to the importer's shape; the agent's note becomes the description. */
export const toImportedBookmark = (entry: InboxEntry): ImportedBookmark => {
  const item: ImportedBookmark = {
    url: entry.url,
    title: entry.title ?? '',
    folderPath: [],
    tags: entry.tags,
    addedAt: entry.createdAt,
  };
  if (entry.note) item.description = entry.note;
  return item;
};

/** Marks agent-supplied titles on the records this run added as chosen, so analysis keeps them. */
const keepAgentTitles = (entries: InboxEntry[], addedIds: string[]): void => {
  const titled = new Set<string>();
  for (const entry of entries) {
    if (!entry.title?.trim()) continue;
    const url = normalizeInputUrl(entry.url, { allowDotlessHost: true });
    if (url) titled.add(canonicalUrlKey(url));
  }
  if (titled.size === 0) return;
  const added = new Set(addedIds);
  for (const resource of store().resources) {
    if (added.has(resource.id) && titled.has(resource.urlKey)) {
      store().updateResource(resource.id, { title: resource.title }, { byUser: true });
    }
  }
};

/** `mcp:claude-code ×2, cli` for the log; the value is spoofable, so it stays out of the UI. */
const sourceSummary = (entries: InboxEntry[]): string => {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const source = entry.source.trim() || 'unknown';
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return [...counts]
    .map(([source, count]) => (count > 1 ? `${source} ×${count}` : source))
    .join(', ');
};

const runDrain = async (): Promise<InboxDrainOutcome> => {
  let files: InboxFile[];
  try {
    files = await peekAgentInbox();
  } catch (error) {
    // A background poll must not put a toast on screen every ten seconds.
    reportError(error, 'agents.inbox.peek', { toast: false });
    return NOTHING;
  }
  if (files.length === 0) return NOTHING;
  const entries = files.map((file) => file.entry);

  // Only the records this import created: another import landing meanwhile is not the agents'.
  let addedIds: string[] = [];
  const outcome = await store().importBookmarks(entries.map(toImportedBookmark), {
    newestFirst: true,
    onAdded: (ids) => {
      addedIds = ids;
    },
  });
  keepAgentTitles(entries, addedIds);

  // Files are removed only once the import is on disk; otherwise the next run merges again.
  const { ok: stored } = await flushPersistence();
  if (stored) {
    try {
      await ackAgentInbox(files.map((file) => file.name));
    } catch (error) {
      // The bookmarks are stored; the next run reads the files again and merges them away.
      reportError(error, 'agents.inbox.ack', { toast: false });
    }
  } else {
    console.warn(
      '[MYNK] agent inbox: the library could not be saved, so the entries are left in the inbox.',
    );
  }

  const summary =
    `agent inbox: ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} from ${sourceSummary(entries)} — ` +
    `added ${outcome.added}, merged ${outcome.merged} (${outcome.unchanged} unchanged), skipped ${outcome.skipped}` +
    (stored ? '' : ' (not stored yet, kept in the inbox)');
  console.info(`[MYNK] ${summary}`);
  // console.info isn't forwarded to the log file; a packaged build still needs this recorded.
  logInfo(summary);

  if (outcome.added > 0) {
    store().pushToast(fmt(getT().settings.agents.imported, { count: outcome.added }), 'success');
  }
  if (addedIds.length > 0) {
    startEnrichment(addedIds, { background: true }).catch((error: unknown) =>
      reportError(error, 'agents.inbox.enrich', { toast: false }),
    );
  }
  return { drained: stored ? entries.length : 0, ...outcome };
};

/** Imports everything the agents left; a no-op outside the desktop app or while writes fail. */
export const drainInboxNow = async (): Promise<InboxDrainOutcome> => {
  if (!isDesktopRuntime()) return NOTHING;
  if (isLibraryWriteBlocked()) {
    console.warn('[MYNK] agent inbox: the library is not writable, so nothing is imported.');
    return NOTHING;
  }
  if (isSaveFailing()) {
    console.warn('[MYNK] agent inbox: the library is not being saved, so nothing is imported.');
    return NOTHING;
  }
  if (running) return running;
  running = runDrain();
  try {
    return await running;
  } finally {
    running = null;
  }
};

const onVisibilityChange = () => {
  // Returning to MYNK is the likely moment a bookmark arrived; don't wait out the poll interval.
  if (document.visibilityState === 'visible') void drainInboxNow();
};

/** Once per app start: imports now, then every {@link INBOX_POLL_MS} and on window focus. */
export const startInboxWatch = (options: { libraryLoaded?: boolean } = {}): void => {
  if (watching || !isDesktopRuntime()) return;
  if (options.libraryLoaded === false || isLibraryWriteBlocked()) {
    console.warn('[MYNK] library not loaded: the agent inbox is left untouched.');
    return;
  }
  watching = true;
  timer = setInterval(() => void drainInboxNow(), INBOX_POLL_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
  void drainInboxNow();
};

const stopInboxWatch = (): void => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  document.removeEventListener('visibilitychange', onVisibilityChange);
  watching = false;
};

/** Test helper: stops the watch and forgets the drain in flight. */
export const resetInboxForTests = (): void => {
  stopInboxWatch();
  running = null;
};
