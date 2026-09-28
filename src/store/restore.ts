/**
 * Restoring a parsed JSON backup: "merge" adds the backup on top of the current library
 * (duplicates by canonical URL merge); "replace" swaps the library data for the backup.
 */
import type { ChatMessage, Collection, Resource } from '../types';
import type { ParsedBackup } from '../lib/export';
import { finalizeReferences } from './migrate';
import { copyChats, dedupeResources, mergeChatLists } from './model';

export type RestoreMode = 'merge' | 'replace';

export interface LibraryData {
  resources: Resource[];
  collections: Collection[];
  chats: Record<string, ChatMessage[]>;
}

export interface RestoreOutcome {
  /** Bookmarks in the backup. */
  resources: number;
  /** Bookmarks that were not in the library yet. */
  added: number;
  /** Bookmarks that already existed (same canonical URL) and were merged into the current one. */
  merged: number;
  /** Collections added from the backup. */
  collections: number;
  /** Collections that already existed and gained keywords / pinned bookmarks. */
  collectionsMerged: number;
}

/** Union of collections; a shared id keeps its current name and gains the backup's keywords/pins. */
const mergeCollections = (
  current: Collection[],
  backup: Collection[],
): { collections: Collection[]; added: number; updated: number } => {
  const byId = new Map(backup.map((c) => [c.id, c]));
  let updated = 0;
  const collections = current.map((collection) => {
    const other = byId.get(collection.id);
    if (!other) return collection;
    byId.delete(collection.id);
    const keywords = [...new Set([...collection.keywords, ...other.keywords])];
    const pinnedIds = [...new Set([...collection.pinnedIds, ...other.pinnedIds])];
    if (
      keywords.length === collection.keywords.length &&
      pinnedIds.length === collection.pinnedIds.length
    ) {
      return collection;
    }
    updated += 1;
    return {
      ...collection,
      keywords,
      pinnedIds,
      updatedAt: Math.max(collection.updatedAt, other.updatedAt),
    };
  });
  return { collections: [...collections, ...byId.values()], added: byId.size, updated };
};

export const mergeLibraryData = (
  current: LibraryData,
  backup: ParsedBackup,
  mode: RestoreMode,
): { data: LibraryData; outcome: RestoreOutcome } => {
  if (mode === 'replace') {
    return {
      data: { resources: backup.resources, collections: backup.collections, chats: backup.chats },
      outcome: {
        resources: backup.resources.length,
        added: backup.resources.length,
        merged: 0,
        collections: backup.collections.length,
        collectionsMerged: 0,
      },
    };
  }

  const merged = mergeCollections(current.collections, backup.collections);
  const chats = copyChats(current.chats);
  for (const [key, list] of Object.entries(backup.chats)) {
    chats[key] = mergeChatLists(chats[key] ?? [], list);
  }
  // A duplicate keeps the current record's id and media file names; the backup's may be gone.
  const { resources, remap } = dedupeResources([...current.resources, ...backup.resources], {
    primaryIds: new Set(current.resources.map((r) => r.id)),
  });
  const fixed = finalizeReferences(resources, merged.collections, chats, remap);
  // Counted by canonical URL, not length delta, so a duplicate link isn't reported twice.
  const currentKeys = new Set(current.resources.map((r) => r.urlKey));
  const newKeys = new Set(
    backup.resources.map((r) => r.urlKey).filter((key) => !currentKeys.has(key)),
  );
  return {
    data: { resources, collections: fixed.collections, chats: fixed.chats },
    outcome: {
      resources: backup.resources.length,
      added: newKeys.size,
      merged: backup.resources.length - newKeys.size,
      collections: merged.added,
      collectionsMerged: merged.updated,
    },
  };
};
