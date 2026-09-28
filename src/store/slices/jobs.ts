import type { StateCreator } from 'zustand';
import type { JobKind, JobProgress } from '../../types';
import type { AppState } from '../state';
import { canonicalUrlKey } from '../../lib/url';

export type InviteKind = 'enrich' | 'preview';

/** Background job progress. Never persisted. */
export interface JobsSlice {
  jobs: Record<JobKind, JobProgress | null>;
  /** Resource ids currently being processed per job kind (card / inspector spinners). */
  busy: Record<JobKind, string[]>;
  /** The analysis run was started only by background work (agent inbox), not by the user. */
  enrichInBackground: boolean;
  dismissedInvites: Record<InviteKind, boolean>;
  /** Address a check or analysis ended on, by the checked URL's key; only when it differs. */
  finalUrls: Record<string, string>;
  /** Preview cache size reported by start-up maintenance; `null` until it ran. */
  snapshotCacheBytes: number | null;

  setJob: (kind: JobKind, progress: JobProgress | null) => void;
  setBusy: (kind: JobKind, id: string, busy: boolean) => void;
  setEnrichInBackground: (background: boolean) => void;
  dismissInvite: (kind: InviteKind) => void;
  /** Records where each URL ended up; a missing `finalUrl` forgets an earlier redirect. */
  noteFinalUrls: (entries: Array<{ url: string; finalUrl: string | undefined }>) => void;
  /** Forgets the redirect remembered for these URLs (record removed, or its address changed). */
  forgetFinalUrls: (urls: string[]) => void;
  setSnapshotCacheBytes: (bytes: number | null) => void;
}

export const createJobsSlice: StateCreator<AppState, [], [], JobsSlice> = (set) => ({
  jobs: { enrich: null, health: null, preview: null },
  busy: { enrich: [], health: [], preview: [] },
  enrichInBackground: false,
  dismissedInvites: { enrich: false, preview: false },
  finalUrls: {},
  snapshotCacheBytes: null,

  setJob: (kind, progress) => set((state) => ({ jobs: { ...state.jobs, [kind]: progress } })),
  setBusy: (kind, id, busy) =>
    set((state) => {
      const list = state.busy[kind];
      const has = list.includes(id);
      if (busy === has) return state;
      return {
        busy: {
          ...state.busy,
          [kind]: busy ? [...list, id] : list.filter((item) => item !== id),
        },
      };
    }),
  setEnrichInBackground: (enrichInBackground) => set({ enrichInBackground }),
  dismissInvite: (kind) =>
    set((state) => ({ dismissedInvites: { ...state.dismissedInvites, [kind]: true } })),
  noteFinalUrls: (entries) =>
    set((state) => {
      let finalUrls = state.finalUrls;
      for (const { url, finalUrl } of entries) {
        const key = canonicalUrlKey(url);
        const target =
          finalUrl !== undefined && canonicalUrlKey(finalUrl) !== key ? finalUrl : undefined;
        if (finalUrls[key] === target) continue;
        if (finalUrls === state.finalUrls) finalUrls = { ...finalUrls };
        if (target === undefined) delete finalUrls[key];
        else finalUrls[key] = target;
      }
      return finalUrls === state.finalUrls ? state : { finalUrls };
    }),
  forgetFinalUrls: (urls) =>
    set((state) => {
      let finalUrls = state.finalUrls;
      for (const url of urls) {
        const key = canonicalUrlKey(url);
        if (!(key in finalUrls)) continue;
        if (finalUrls === state.finalUrls) finalUrls = { ...finalUrls };
        delete finalUrls[key];
      }
      return finalUrls === state.finalUrls ? state : { finalUrls };
    }),
  setSnapshotCacheBytes: (snapshotCacheBytes) => set({ snapshotCacheBytes }),
});
