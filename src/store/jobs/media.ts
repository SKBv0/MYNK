/**
 * Remote media cache: Rust downloads favicons/og:images into the snapshot directory, referenced
 * by file name only. No toasts; concurrency 4, at most one request per host.
 */
import { cacheRemoteImage } from '../../services/snapshots';
import { isDesktopRuntime } from '../../services/ipc';
import type { RemoteImageKind } from '../../services/ipcTypes';
import { JobQueue } from '../../services/jobs/jobQueue';
import { MEDIA_FILE_KEYS, needsRemoteMediaCache } from '../../services/resourceMedia';
import { hostOf } from '../../lib/url';
import { toIpcError } from '../../services/ipc';
import type { MediaPatch, Resource, ResourceMedia } from '../../types';
import { useAppStore } from '../index';
import { resourceById } from '../selectors';

export const MEDIA_CONCURRENCY = 4;
/** Batch window: a burst of finished downloads costs one store write, not one per image. */
const FLUSH_MS = 300;

export interface MediaCacheOutcome {
  faviconUrl?: string;
  /** `undefined` records a failed download (a stale cached copy is dropped). */
  faviconFile?: string | undefined;
  imageUrl?: string;
  imageFile?: string | undefined;
}

/** FIFO gate that lets `perHost` tasks per host run at once. Exported for tests. */
export class HostGate {
  private readonly running = new Map<string, number>();
  private readonly waiting = new Map<string, (() => void)[]>();

  constructor(private readonly perHost = 1) {}

  async acquire(host: string): Promise<() => void> {
    const active = this.running.get(host) ?? 0;
    if (active < this.perHost) {
      this.running.set(host, active + 1);
    } else {
      await new Promise<void>((resolve) => {
        const list = this.waiting.get(host) ?? [];
        list.push(resolve);
        this.waiting.set(host, list);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.get(host)?.shift();
      if (next) {
        // The slot is handed over directly; the running count stays the same.
        next();
        return;
      }
      this.waiting.delete(host);
      const count = (this.running.get(host) ?? 1) - 1;
      if (count <= 0) this.running.delete(host);
      else this.running.set(host, count);
    };
  }
}

let queue: JobQueue<MediaCacheOutcome> | null = null;
let gate = new HostGate(1);
let backfillStarted = false;

const store = () => useAppStore.getState();

const pendingPatches = new Map<string, MediaPatch>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Applies batched media patches; a no-op flush keeps the same `resources` array reference. */
export const flushMediaPatches = (): void => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingPatches.size === 0) return;
  const patches = new Map(pendingPatches);
  pendingPatches.clear();
  store().applyMediaPatches(patches);
};

const queuePatch = (id: string, patch: MediaPatch) => {
  pendingPatches.set(id, { ...pendingPatches.get(id), ...patch });
  if (flushTimer === null) flushTimer = setTimeout(flushMediaPatches, FLUSH_MS);
};

/** Store patch for a finished caching attempt; applied only if the URL is still current. */
export const mediaPatchFor = (
  media: ResourceMedia,
  outcome: MediaCacheOutcome,
  now: number,
): MediaPatch | null => {
  const patch: MediaPatch = {};
  let applied = false;
  if (outcome.faviconUrl !== undefined && outcome.faviconUrl === media.faviconUrl) {
    patch.faviconFile = outcome.faviconFile;
    applied = true;
  }
  if (outcome.imageUrl !== undefined && outcome.imageUrl === media.imageUrl) {
    patch.imageFile = outcome.imageFile;
    applied = true;
  }
  if (!applied) return null;
  patch.remoteCachedAt = now;
  return patch;
};

/** Drops references to evicted files; `remoteCachedAt` avoids re-downloading them right away. */
export const clearMediaReferences = (fileNames: string[]): void => {
  if (fileNames.length === 0) return;
  const gone = new Set(fileNames);
  for (const resource of store().resources) {
    const patch: MediaPatch = {};
    let touched = false;
    for (const key of MEDIA_FILE_KEYS) {
      const file = resource.media[key];
      if (file && gone.has(file)) {
        patch[key] = undefined;
        touched = true;
      }
    }
    if (touched) queuePatch(resource.id, patch);
  }
  flushMediaPatches();
};

/**
 * Downloads one image (failures resolve `undefined`); checks `signal` before and after the
 * host gate since `cache_remote_image` has no run id to cancel.
 */
const cacheOne = async (
  url: string,
  kind: RemoteImageKind,
  signal: AbortSignal,
): Promise<string | undefined> => {
  if (signal.aborted) return undefined;
  const release = await gate.acquire(hostOf(url) || url);
  try {
    if (signal.aborted) return undefined;
    return await cacheRemoteImage(url, kind);
  } catch (error) {
    const ipcError = toIpcError(error);
    if (ipcError.kind === 'desktopOnly') throw ipcError;
    console.info(`[MYNK] media cache: ${kind} not cached (${ipcError.kind}): ${ipcError.message}`);
    return undefined;
  } finally {
    release();
  }
};

const runTask = async (id: string, signal: AbortSignal): Promise<MediaCacheOutcome> => {
  const resource = resourceById(store().resources, id);
  const outcome: MediaCacheOutcome = {};
  if (!resource) return outcome;
  const { faviconUrl, imageUrl } = resource.media;
  if (faviconUrl && !signal.aborted) {
    outcome.faviconUrl = faviconUrl;
    outcome.faviconFile = await cacheOne(faviconUrl, 'favicon', signal);
  }
  if (imageUrl && !signal.aborted) {
    outcome.imageUrl = imageUrl;
    outcome.imageFile = await cacheOne(imageUrl, 'image', signal);
  }
  return outcome;
};

const createQueue = (): JobQueue<MediaCacheOutcome> => {
  const q: JobQueue<MediaCacheOutcome> = new JobQueue<MediaCacheOutcome>({
    concurrency: MEDIA_CONCURRENCY,
    // Per-URL failures are handled in `cacheOne`; nothing here is worth retrying.
    maxRetries: 0,
    throttleMs: 0,
    onTaskSuccess: (id, outcome) => {
      // A download that was already running when the job was cancelled still reports here.
      if (q.progress.state === 'cancelled') return;
      const resource = resourceById(store().resources, id);
      if (!resource) return;
      const patch = mediaPatchFor(resource.media, outcome, Date.now());
      if (patch) queuePatch(id, patch);
    },
  });
  return q;
};

/** Caches the remote favicon/og:image of the given resources; resolves when the queue is idle. */
export const queueMediaCache = async (ids: string[]): Promise<void> => {
  if (!isDesktopRuntime() || ids.length === 0) return;
  const idSet = new Set(ids);
  const targets = store().resources.filter(
    (r) => idSet.has(r.id) && Boolean(r.media.faviconUrl || r.media.imageUrl),
  );
  if (targets.length === 0) return;
  const existing = queue?.isActive ? queue : null;
  const q = existing ?? (queue = createQueue());
  q.add(
    targets.map((target) => ({ targetId: target.id, run: (signal) => runTask(target.id, signal) })),
  );
  // Attach after `add`: a fresh queue is idle (whenIdle resolves at once) until it has tasks.
  if (!existing) {
    void q.whenIdle().then(() => {
      flushMediaPatches();
      if (queue === q) queue = null;
    });
  }
  await q.whenIdle();
};

/** Resources whose remote media was never cached (lazy backfill targets). */
export const mediaBackfillTargets = (resources: Resource[]): string[] =>
  resources.filter(needsRemoteMediaCache).map((r) => r.id);

/** Once per app start (after `initMediaOnce`): cache media of pre-existing records. */
export const startMediaBackfill = async (): Promise<void> => {
  if (backfillStarted || !isDesktopRuntime()) return;
  backfillStarted = true;
  await queueMediaCache(mediaBackfillTargets(store().resources));
};

export const cancelMediaCache = (): void => {
  queue?.cancel();
  flushMediaPatches();
};

/** Test helper: resets module state. */
export const resetMediaCacheForTests = (): void => {
  queue?.cancel();
  queue = null;
  gate = new HostGate(1);
  backfillStarted = false;
  pendingPatches.clear();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
};
