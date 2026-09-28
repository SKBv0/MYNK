import type { StateCreator } from 'zustand';
import type { AnalyzeResult, ImportedBookmark, LinkHealthResult } from '../../services/ipcTypes';
import type {
  AiStatus,
  CategoryId,
  HealthMeta,
  MediaPatch,
  Resource,
  ResourceHealth,
} from '../../types';
import type { AppState } from '../state';
import {
  applyAnalysisToResource,
  cleanSummary,
  copyChats,
  createResource,
  type ResourceInit,
} from '../model';
import {
  canonicalUrlKey,
  looksLikeUrl,
  normalizeInputUrl,
  stripCredentials,
  type NormalizeUrlOptions,
} from '../../lib/url';
import { yieldToMain } from '../../lib/scheduling';
import { applyMediaPatch, sameMedia } from '../../services/resourceMedia';
import { normalizeSearchText, normalizeTags, sameList } from '../../lib/text';
import { ROOT_FOLDER_NAMES } from '../../lib/categories';
import type { ParsedBackup } from '../../lib/export';
import { mergeLibraryData, type RestoreMode, type RestoreOutcome } from '../restore';

export interface ResourcePatch {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: CategoryId;
  summary?: string[];
  /** New address; ignored when invalid or when another record already has its URL key. */
  url?: string;
}

export type ImportOutcome = {
  added: number;
  /** Bookmarks that matched an existing record, `unchanged` included. */
  merged: number;
  /** Matches that brought nothing new; the record is kept as it was. */
  unchanged: number;
  /** Bookmarks without a usable address. */
  skipped: number;
};

export interface ImportOptions {
  /** Receives the ids of the records this import created (not ones added meanwhile). */
  onAdded?: (ids: string[]) => void;
  /** Puts the created records first, the way a single added link appears. */
  newestFirst?: boolean;
}

export interface HealthApplyOutcome {
  dead: number;
  protected: number;
  uncertain: number;
}

export interface LibrarySlice {
  resources: Resource[];
  healthMeta: HealthMeta;

  /** Adds a resource; when the canonical URL already exists the existing record is returned. */
  addResource: (
    init: ResourceInit,
    options?: NormalizeUrlOptions,
  ) => { resource: Resource; duplicate: boolean } | null;
  updateResource: (id: string, patch: ResourcePatch, opts?: { byUser?: boolean }) => void;
  /** Removes resources and every reference to them; returns the removed records. */
  removeResources: (ids: string[]) => Resource[];
  toggleFavorite: (id: string) => void;
  markOpened: (id: string) => void;
  setAiStatus: (ids: string[], status: AiStatus, error?: string) => void;
  /** `baseUpdatedAt`: the record's `updatedAt` at analysis start (see `applyAnalysisToResource`). */
  applyAnalysis: (id: string, result: AnalyzeResult, baseUpdatedAt?: number) => void;
  applyHealthResults: (results: LinkHealthResult[]) => HealthApplyOutcome;
  /** Merges a media patch; keys set to `undefined` are removed. */
  applyPreview: (id: string, patch: MediaPatch) => void;
  /** Merges batched media patches by id; `updatedAt` stays, as caching media is not an edit. */
  applyMediaPatches: (patches: ReadonlyMap<string, MediaPatch>) => void;
  /** Adds imported bookmarks, merging duplicates by canonical URL; yields between slices, one `set`. */
  importBookmarks: (items: ImportedBookmark[], options?: ImportOptions) => Promise<ImportOutcome>;
  setHealthMeta: (meta: HealthMeta) => void;
  /** Factory reset of the library data (resources, collections, chats). */
  resetLibrary: () => void;
  /** Restores a parsed JSON backup, merged into or replacing the current library. */
  restoreLibrary: (backup: ParsedBackup, mode: RestoreMode) => RestoreOutcome;
}

/**
 * Browser root folders that carry no meaning as tags: the shared names plus bare labels that
 * only a folder would be called.
 */
const ROOT_FOLDERS = new Set([
  ...ROOT_FOLDER_NAMES,
  ...['toolbar', 'menu', 'unfiled'].map(normalizeSearchText),
]);

/** Last two meaningful folder names, normalized, as tags. */
export const folderTags = (folderPath: string[]): string[] =>
  normalizeTags(
    folderPath.filter((name) => !ROOT_FOLDERS.has(normalizeSearchText(name.trim()))).slice(-2),
  );

/** Records per synchronous slice of an import; the browser gets control between slices. */
export const IMPORT_CHUNK_SIZE = 5000;
/** Merging does more per record (tags, title check), so its slices are smaller. */
const MERGE_CHUNK_SIZE = IMPORT_CHUNK_SIZE / 2;

/** An imported bookmark turned into a record, or `null` when its URL is unusable. */
type Candidate = Resource | null;

const buildCandidates = async (items: ImportedBookmark[], now: number): Promise<Candidate[]> => {
  // Imports repeat the same few folder paths thousands of times; their tags are computed once.
  const tagsByFolder = new Map<string, string[]>();
  const candidates = new Array<Candidate>(items.length);
  for (let i = 0; i < items.length; i += 1) {
    if (i > 0 && i % IMPORT_CHUNK_SIZE === 0) await yieldToMain();
    const item = items[i] as ImportedBookmark;
    const folderPath = item.folderPath ?? [];
    const folderKey = folderPath.join('\u0000');
    let tags = tagsByFolder.get(folderKey);
    if (!tags) {
      tags = folderTags(folderPath);
      tagsByFolder.set(folderKey, tags);
    }
    candidates[i] = createResource(
      {
        url: item.url,
        title: item.title,
        description: item.description,
        folderPath: item.folderPath,
        // The file's own tags go first so `normalizeTags` drops folder-derived ones at the cap.
        tags: item.tags && item.tags.length > 0 ? [...item.tags, ...tags] : tags,
        createdAt: item.addedAt,
        updatedAt: item.updatedAt,
      },
      now,
      // Intranet bookmarks (e.g. `http://wiki/`) always carry a scheme, so they're accepted here.
      { allowDotlessHost: true },
    );
  }
  return candidates;
};

interface MergeState {
  next: Resource[];
  indexByKey: Map<string, number>;
  outcome: ImportOutcome;
  addedIds: string[];
}

const startMerge = (base: Resource[]): MergeState => {
  const next = base.slice();
  const indexByKey = new Map<string, number>();
  for (let i = 0; i < next.length; i += 1) indexByKey.set((next[i] as Resource).urlKey, i);
  return {
    next,
    indexByKey,
    outcome: { added: 0, merged: 0, unchanged: 0, skipped: 0 },
    addedIds: [],
  };
};

/** Merges `candidates[from, to)` into the merge state (synchronous). */
const mergeRange = (state: MergeState, candidates: Candidate[], from: number, to: number) => {
  const { next, indexByKey, outcome, addedIds } = state;
  for (let i = from; i < to; i += 1) {
    const created = candidates[i];
    if (!created) {
      outcome.skipped += 1;
      continue;
    }
    const existingIndex = indexByKey.get(created.urlKey);
    const existing = existingIndex === undefined ? undefined : next[existingIndex];
    if (existingIndex === undefined || !existing) {
      indexByKey.set(created.urlKey, next.length);
      next.push(created);
      addedIds.push(created.id);
      outcome.added += 1;
      continue;
    }
    outcome.merged += 1;
    const title =
      !existing.titleEditedByUser &&
      looksLikeUrl(existing.title, existing.url) &&
      !looksLikeUrl(created.title, created.url)
        ? created.title
        : existing.title;
    const tags = normalizeTags([...existing.tags, ...created.tags]);
    // A note that arrives with the address replaces the AI's own description, never a note or
    // an imported description already there.
    const incoming = created.description.trim();
    // A round trip through an HTML export collapses whitespace; that is not a new note.
    const sameText = (a: string, b: string) =>
      a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
    const description =
      !existing.description.trim() ||
      (existing.descriptionByAi && incoming && !sameText(incoming, existing.description))
        ? incoming || existing.description
        : existing.description;
    // The latest import has the current folder (tags from other folders stay).
    const folderPath = created.folderPath.length > 0 ? created.folderPath : existing.folderPath;
    const createdAt = Math.min(existing.createdAt, created.createdAt);
    if (
      title === existing.title &&
      sameList(tags, existing.tags) &&
      description === existing.description &&
      sameList(folderPath, existing.folderPath) &&
      createdAt === existing.createdAt
    ) {
      outcome.unchanged += 1;
      continue;
    }
    const merged: Resource = { ...existing, title, tags, description, folderPath, createdAt };
    if (description !== existing.description) delete merged.descriptionByAi;
    next[existingIndex] = merged;
  }
};

/**
 * Single-id update without mapping the whole library; returns the same array when the record
 * is missing or `update` hands the record back unchanged.
 */
const replaceOne = (
  resources: Resource[],
  id: string,
  update: (resource: Resource) => Resource,
): Resource[] => {
  const index = resources.findIndex((r) => r.id === id);
  if (index < 0) return resources;
  const current = resources[index] as Resource;
  const updated = update(current);
  if (updated === current) return resources;
  const next = resources.slice();
  next[index] = updated;
  return next;
};

const mapById = (
  resources: Resource[],
  ids: Set<string>,
  update: (resource: Resource) => Resource,
): Resource[] => {
  let changed = false;
  const next = resources.map((resource) => {
    if (!ids.has(resource.id)) return resource;
    const updated = update(resource);
    if (updated !== resource) changed = true;
    return updated;
  });
  return changed ? next : resources;
};

/** Health record without an `httpStatus` key when the check produced no status. */
const withHttpStatus = (health: ResourceHealth, httpStatus: number | undefined): ResourceHealth =>
  httpStatus === undefined ? health : { ...health, httpStatus };

/** Reachable but gated: a bot wall or an auth/rate-limit status, not a broken link. */
export const isProtectedResult = (result: LinkHealthResult): boolean =>
  result.previewBlocked || result.status === 401 || result.status === 403 || result.status === 429;

const healthFromResult = (
  previous: ResourceHealth,
  result: LinkHealthResult,
  now: number,
): ResourceHealth => {
  if (result.definitelyBroken) {
    const dead = withHttpStatus({ status: 'dead', checkedAt: now }, result.status);
    return result.errorKind === 'none' ? dead : { ...dead, errorKind: result.errorKind };
  }
  if (result.ok) {
    return withHttpStatus(
      { status: isProtectedResult(result) ? 'protected' : 'alive', checkedAt: now },
      result.status,
    );
  }
  // Timeout / refused / 5xx: not conclusive, so the known state stays.
  return previous;
};

export const createLibrarySlice: StateCreator<AppState, [], [], LibrarySlice> = (set, get) => ({
  resources: [],
  healthMeta: { hasRun: false, lastScanAt: null },

  addResource: (init, options) => {
    const resource = createResource(init, Date.now(), options);
    if (!resource) return null;
    const existing = get().resources.find((r) => r.urlKey === resource.urlKey);
    if (existing) return { resource: existing, duplicate: true };
    set((state) => ({ resources: [resource, ...state.resources] }));
    return { resource, duplicate: false };
  },

  // A no-op patch keeps the record and state object as-is, so no re-render or disk write follows.
  updateResource: (id, patch, opts) => {
    /** Addresses this patch left behind; their remembered redirects are dropped. */
    const replacedUrls: string[] = [];
    set((state) => {
      const resources = replaceOne(state.resources, id, (resource) => {
        const next: Resource = { ...resource };
        let changed = false;
        if (patch.title !== undefined) {
          const title = patch.title.trim();
          if (title && title !== resource.title) {
            next.title = title;
            changed = true;
          }
          if (opts?.byUser && title && !resource.titleEditedByUser) {
            next.titleEditedByUser = true;
            changed = true;
          }
        }
        if (patch.description !== undefined && patch.description !== resource.description) {
          next.description = patch.description;
          // Whoever patches the description owns it from here on; the AI leaves it alone.
          delete next.descriptionByAi;
          changed = true;
        }
        if (patch.tags !== undefined) {
          const tags = normalizeTags(patch.tags);
          if (!sameList(tags, resource.tags)) {
            next.tags = tags;
            changed = true;
          }
          if (opts?.byUser && !resource.tagsEditedByUser) {
            next.tagsEditedByUser = true;
            changed = true;
          }
        }
        if (patch.categoryId !== undefined && patch.categoryId !== resource.categoryId) {
          next.categoryId = patch.categoryId;
          changed = true;
        }
        if (patch.summary !== undefined) {
          const summary = cleanSummary(patch.summary);
          if (!sameList(summary, resource.summary)) {
            next.summary = summary;
            changed = true;
          }
          if (opts?.byUser && !resource.summaryEditedByUser) {
            next.summaryEditedByUser = true;
            changed = true;
          }
        }
        if (patch.url !== undefined) {
          const normalized = normalizeInputUrl(patch.url, { allowDotlessHost: true });
          // A redirect target may carry `user:password@`; storing that would leak the secret.
          const url = normalized === null ? null : stripCredentials(normalized);
          const urlKey = url === null ? null : canonicalUrlKey(url);
          const taken =
            urlKey !== null &&
            urlKey !== resource.urlKey &&
            state.resources.some((r) => r.urlKey === urlKey);
          if (url !== null && urlKey !== null && url !== resource.url && !taken) {
            replacedUrls.push(resource.url);
            next.url = url;
            next.urlKey = urlKey;
            changed = true;
          }
        }
        if (!changed) return resource;
        next.updatedAt = Date.now();
        return next;
      });
      return resources === state.resources ? state : { resources };
    });
    if (replacedUrls.length > 0) get().forgetFinalUrls(replacedUrls);
  },

  removeResources: (ids) => {
    const idSet = new Set(ids);
    const removed = get().resources.filter((r) => idSet.has(r.id));
    if (removed.length === 0) return [];
    set((state) => {
      const chats = copyChats(state.chats);
      for (const id of idSet) delete chats[id];
      return {
        resources: state.resources.filter((r) => !idSet.has(r.id)),
        batchSelectedIds: state.batchSelectedIds.filter((id) => !idSet.has(id)),
        selectedResourceId:
          state.selectedResourceId && idSet.has(state.selectedResourceId)
            ? null
            : state.selectedResourceId,
        chats,
        collections: state.collections.some((c) => c.pinnedIds.some((id) => idSet.has(id)))
          ? state.collections.map((c) =>
              c.pinnedIds.some((id) => idSet.has(id))
                ? { ...c, pinnedIds: c.pinnedIds.filter((id) => !idSet.has(id)) }
                : c,
            )
          : state.collections,
      };
    });
    get().forgetFinalUrls(removed.map((r) => r.url));
    return removed;
  },

  toggleFavorite: (id) =>
    set((state) => ({
      resources: replaceOne(state.resources, id, (r) => ({
        ...r,
        isFavorite: !r.isFavorite,
      })),
    })),

  markOpened: (id) =>
    set((state) => ({
      resources: replaceOne(state.resources, id, (r) => ({
        ...r,
        lastOpenedAt: Date.now(),
      })),
    })),

  setAiStatus: (ids, status, error) =>
    set((state) => {
      const update = (r: Resource): Resource => {
        if (r.ai.status === status && r.ai.error === error) return r;
        const ai = { ...r.ai, status };
        if (error) ai.error = error;
        else delete ai.error;
        return { ...r, ai };
      };
      // A job reports one record at a time; only bulk callers pay for the full map.
      const first = ids[0];
      return {
        resources:
          ids.length === 1 && first !== undefined
            ? replaceOne(state.resources, first, update)
            : mapById(state.resources, new Set(ids), update),
      };
    }),

  applyAnalysis: (id, result, baseUpdatedAt) =>
    set((state) => ({
      resources: replaceOne(state.resources, id, (r) =>
        applyAnalysisToResource(r, result, Date.now(), baseUpdatedAt),
      ),
    })),

  applyHealthResults: (results) => {
    const outcome: HealthApplyOutcome = { dead: 0, protected: 0, uncertain: 0 };
    if (results.length === 0) return outcome;
    const byKey = new Map<string, LinkHealthResult>();
    for (const result of results) {
      byKey.set(canonicalUrlKey(result.url), result);
      if (result.definitelyBroken) outcome.dead += 1;
      else if (!result.ok) outcome.uncertain += 1;
      else if (isProtectedResult(result)) outcome.protected += 1;
    }
    const now = Date.now();
    set((state) => {
      let changed = false;
      const resources = state.resources.map((resource) => {
        const result = byKey.get(resource.urlKey);
        if (!result) return resource;
        const health = healthFromResult(resource.health, result, now);
        let media = resource.media;
        if (result.ok && result.previewBlocked !== Boolean(resource.media.previewBlocked)) {
          media = { ...resource.media };
          if (result.previewBlocked) media.previewBlocked = true;
          else delete media.previewBlocked;
        }
        if (health === resource.health && media === resource.media) return resource;
        changed = true;
        return { ...resource, health, media };
      });
      // No matching record changed: keep the same array so persistence is not triggered.
      return changed ? { resources } : state;
    });
    return outcome;
  },

  applyPreview: (id, patch) =>
    set((state) => {
      const resources = replaceOne(state.resources, id, (r) => {
        const media = applyMediaPatch(r.media, patch, { dropFalse: true });
        return sameMedia(media, r.media) ? r : { ...r, media };
      });
      return resources === state.resources ? state : { resources };
    }),

  applyMediaPatches: (patches) =>
    set((state) => {
      const resources = mapById(state.resources, new Set(patches.keys()), (r) => {
        const patch = patches.get(r.id);
        if (!patch) return r;
        const media = applyMediaPatch(r.media, patch);
        return sameMedia(media, r.media) ? r : { ...r, media };
      });
      return resources === state.resources ? state : { resources };
    }),

  importBookmarks: async (items, options) => {
    const candidates = await buildCandidates(items, Date.now());
    const base = get().resources;
    let merge = startMerge(base);
    for (let from = 0; from < candidates.length; from += MERGE_CHUNK_SIZE) {
      // Also after `startMerge`: indexing a large library is a slice of its own.
      if (from > 0 || base.length >= IMPORT_CHUNK_SIZE) await yieldToMain();
      mergeRange(merge, candidates, from, Math.min(from + MERGE_CHUNK_SIZE, candidates.length));
    }
    if (get().resources !== base) {
      // The library changed while the merge yielded: redo it against the current list.
      merge = startMerge(get().resources);
      mergeRange(merge, candidates, 0, candidates.length);
    }
    const { outcome, addedIds } = merge;
    let { next } = merge;
    if (options?.newestFirst && addedIds.length > 0) {
      const added = new Set(addedIds);
      next = [...next.filter((r) => added.has(r.id)), ...next.filter((r) => !added.has(r.id))];
    }
    if (outcome.added > 0 || outcome.merged > outcome.unchanged) set({ resources: next });
    options?.onAdded?.(addedIds);
    return outcome;
  },

  setHealthMeta: (healthMeta) => set({ healthMeta }),

  resetLibrary: () =>
    set({
      resources: [],
      collections: [],
      chats: copyChats(),
      batchSelectedIds: [],
      selectedResourceId: null,
      scope: 'all',
      healthMeta: { hasRun: false, lastScanAt: null },
      finalUrls: {},
    }),

  restoreLibrary: (backup, mode) => {
    const state = get();
    const { data, outcome } = mergeLibraryData(
      { resources: state.resources, collections: state.collections, chats: state.chats },
      backup,
      mode,
    );
    set({
      resources: data.resources,
      collections: data.collections,
      chats: data.chats,
      batchSelectedIds: [],
      selectedResourceId: null,
      ...(mode === 'replace' ? { scope: 'all' as const, finalUrls: {} } : {}),
    });
    return outcome;
  },
});
