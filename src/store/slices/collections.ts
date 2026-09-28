import type { StateCreator } from 'zustand';
import type { Collection } from '../../types';
import type { AppState } from '../state';
import { newId } from '../../lib/id';
import { normalizeTags, sameList } from '../../lib/text';

export interface CollectionInput {
  name: string;
  description: string;
  keywords: string[];
}

export interface CollectionsSlice {
  collections: Collection[];
  createCollection: (input: CollectionInput) => Collection | null;
  updateCollection: (id: string, patch: Partial<CollectionInput>) => void;
  deleteCollection: (id: string) => void;
  togglePin: (collectionId: string, resourceId: string) => void;
}

export const createCollectionsSlice: StateCreator<AppState, [], [], CollectionsSlice> = (set) => ({
  collections: [],

  createCollection: (input) => {
    const name = input.name.trim();
    if (!name) return null;
    const now = Date.now();
    const collection: Collection = {
      id: newId(),
      name,
      description: input.description.trim(),
      keywords: normalizeTags(input.keywords, 64),
      pinnedIds: [],
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({ collections: [...state.collections, collection] }));
    return collection;
  },

  // A patch that changes nothing keeps the collection, its `updatedAt` and the state object.
  updateCollection: (id, patch) =>
    set((state) => {
      let changed = false;
      const collections = state.collections.map((c) => {
        if (c.id !== id) return c;
        const next: Collection = { ...c };
        let dirty = false;
        const name = patch.name?.trim();
        if (name && name !== c.name) {
          next.name = name;
          dirty = true;
        }
        const description = patch.description?.trim();
        if (description !== undefined && description !== c.description) {
          next.description = description;
          dirty = true;
        }
        if (patch.keywords !== undefined) {
          const keywords = normalizeTags(patch.keywords, 64);
          if (!sameList(keywords, c.keywords)) {
            next.keywords = keywords;
            dirty = true;
          }
        }
        if (!dirty) return c;
        changed = true;
        next.updatedAt = Date.now();
        return next;
      });
      return changed ? { collections } : state;
    }),

  deleteCollection: (id) =>
    set((state) => ({
      collections: state.collections.filter((c) => c.id !== id),
      scope:
        typeof state.scope === 'object' && state.scope.collectionId === id ? 'all' : state.scope,
    })),

  togglePin: (collectionId, resourceId) =>
    set((state) => ({
      collections: state.collections.map((c) => {
        if (c.id !== collectionId) return c;
        const pinned = c.pinnedIds.includes(resourceId);
        return {
          ...c,
          updatedAt: Date.now(),
          pinnedIds: pinned
            ? c.pinnedIds.filter((id) => id !== resourceId)
            : [...c.pinnedIds, resourceId],
        };
      }),
    })),
});
