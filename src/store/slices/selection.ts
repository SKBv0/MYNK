import type { StateCreator } from 'zustand';
import type { AppState } from '../state';
import { selectedIdSet } from '../selectors';

/** Search and selection state. Never persisted: typing in the search box must not touch disk. */
export interface SelectionSlice {
  searchQuery: string;
  selectedResourceId: string | null;
  batchSelectedIds: string[];

  setSearchQuery: (query: string) => void;
  selectResource: (id: string | null) => void;
  toggleBatch: (id: string) => void;
  setBatch: (ids: string[]) => void;
  clearBatch: () => void;
}

export const createSelectionSlice: StateCreator<AppState, [], [], SelectionSlice> = (set) => ({
  searchQuery: '',
  selectedResourceId: null,
  batchSelectedIds: [],

  setSearchQuery: (searchQuery) => set({ searchQuery }),
  selectResource: (selectedResourceId) => set({ selectedResourceId }),
  toggleBatch: (id) =>
    set((state) => ({
      batchSelectedIds: selectedIdSet(state.batchSelectedIds).has(id)
        ? state.batchSelectedIds.filter((item) => item !== id)
        : [...state.batchSelectedIds, id],
    })),
  setBatch: (batchSelectedIds) => set({ batchSelectedIds }),
  clearBatch: () => set({ batchSelectedIds: [] }),
});
