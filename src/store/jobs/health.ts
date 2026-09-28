/**
 * Link health scan, chunked so cancellation keeps partial results; `health-scan-progress`
 * is per-call, not cumulative.
 */
import {
  cancelHealthScan as cancelHealthScanIpc,
  checkLinksHealth,
  onHealthScanProgress,
} from '../../services/linkHealth';
import { isDesktopRuntime } from '../../services/ipc';
import type { LinkHealthResult } from '../../services/ipcTypes';
import { JobQueue } from '../../services/jobs/jobQueue';
import { newId } from '../../lib/id';
import { reportError } from '../../lib/errors';
import { fmt } from '../../lib/text';
import { hostOf } from '../../lib/url';
import { getT, useAppStore } from '../index';
import { isProtectedResult } from '../slices/library';
import { publishJob, throttle } from './shared';

export const HEALTH_CHUNK_SIZE = 50;
/** Chunks in flight at once, so one hanging URL holds up only its own chunk. */
export const HEALTH_CHUNK_CONCURRENCY = 3;

interface HealthRun {
  scanId: string;
  /** Run ids of the chunks in flight (what `cancel_health_scan` must target). */
  activeRunIds: Set<string>;
  queue: JobQueue<LinkHealthResult[]>;
  cancelled: boolean;
}

/** Run id of one chunk call. Exported for tests. */
export const chunkRunId = (scanId: string, index: number): string => `${scanId}:${index}`;

/** Overall progress: settled chunks plus each running chunk's progress, clamped to its size. */
export const scanDone = (
  total: number,
  settledUrls: number,
  inFlight: Iterable<{ processed: number; size: number }>,
): number => {
  let running = 0;
  for (const chunk of inFlight) running += Math.min(Math.max(0, chunk.processed), chunk.size);
  return Math.min(total, settledUrls + running);
};

/** Splits the URLs into chunks, keeping one host's URLs together so fewer chunks share a host. */
export const healthChunks = (urls: string[], size = HEALTH_CHUNK_SIZE): string[][] => {
  const byHost = new Map<string, string[]>();
  for (const url of urls) {
    const host = hostOf(url);
    const list = byHost.get(host);
    if (list) list.push(url);
    else byHost.set(host, [url]);
  }
  const ordered = [...byHost.values()].flat();
  const chunks: string[][] = [];
  for (let i = 0; i < ordered.length; i += size) chunks.push(ordered.slice(i, i + size));
  return chunks;
};

/**
 * Next chunk to start: the first with no URL on a busy host, else the one with the most URLs on
 * idle hosts, so a host whose slots hang holds up as few lanes as possible. Exported for tests.
 */
export const pickFreeHostChunk = (
  pending: readonly number[],
  urlHosts: readonly (readonly string[])[],
  busyHosts: ReadonlyMap<string, number>,
): number => {
  let best = 0;
  let bestIdle = -1;
  for (const [index, chunk] of pending.entries()) {
    const hosts = urlHosts[chunk] ?? [];
    const idle = hosts.filter((host) => !busyHosts.has(host)).length;
    if (idle === hosts.length) return index;
    if (idle > bestIdle) {
      best = index;
      bestIdle = idle;
    }
  }
  return best;
};

let current: HealthRun | null = null;

const store = () => useAppStore.getState();

export const startHealthScan = async (): Promise<void> => {
  if (!isDesktopRuntime()) {
    store().pushToast(getT().errors.desktopOnly, 'info');
    return;
  }
  if (current) return;

  const urlsByKey = new Map<string, string>();
  for (const resource of store().resources) {
    if (!urlsByKey.has(resource.urlKey)) urlsByKey.set(resource.urlKey, resource.url);
  }
  const urls = [...urlsByKey.values()];
  if (urls.length === 0) return;

  const chunks = healthChunks(urls);
  const urlHosts = chunks.map((chunk) => chunk.map(hostOf));
  /** Running chunks per host. */
  const busyHosts = new Map<string, number>();
  const trackHosts = (index: number, delta: 1 | -1) => {
    for (const host of new Set(urlHosts[index])) {
      const next = (busyHosts.get(host) ?? 0) + delta;
      if (next > 0) busyHosts.set(host, next);
      else busyHosts.delete(host);
    }
  };

  const scanId = newId();
  const startedAt = Date.now();
  const counters = { dead: 0, protected: 0, uncertain: 0 };
  /** URLs of chunks that came back with results (what `healthMeta` may be based on). */
  let completedUrls = 0;
  /** URLs of chunks whose call failed: settled, but no result was applied. */
  let failedUrls = 0;
  /** Progress events of the chunks in flight, by chunk index. */
  const inFlight = new Map<number, { processed: number; size: number }>();
  let failedChunks = 0;
  let state: 'running' | 'cancelled' | 'done' = 'running';

  const publish = throttle(
    () =>
      publishJob(
        'health',
        startedAt,
        {
          state,
          total: urls.length,
          // Failed URLs are settled too, so the bar does not stall; they are reported as failed.
          done: scanDone(urls.length, completedUrls + failedUrls, inFlight.values()),
          failed: failedUrls,
        },
        counters,
      ),
    250,
  );

  const queue = new JobQueue<LinkHealthResult[]>({
    concurrency: HEALTH_CHUNK_CONCURRENCY,
    throttleMs: 0,
    pick: (pending) =>
      pickFreeHostChunk(
        pending.map((task) => Number(task.targetId)),
        urlHosts,
        busyHosts,
      ),
    onTaskStart: (targetId) => {
      const index = Number(targetId);
      trackHosts(index, 1);
      inFlight.set(index, { processed: 0, size: chunks[index]?.length ?? 0 });
      current?.activeRunIds.add(chunkRunId(scanId, index));
    },
    onTaskSuccess: (targetId, results) => {
      const outcome = store().applyHealthResults(results);
      // A login or bot wall is where a gated page sends everyone, not the page's new address.
      store().noteFinalUrls(
        results.map((result) => ({
          url: result.url,
          finalUrl: result.ok && !isProtectedResult(result) ? result.finalUrl : undefined,
        })),
      );
      counters.dead += outcome.dead;
      counters.protected += outcome.protected;
      counters.uncertain += outcome.uncertain;
      completedUrls += chunks[Number(targetId)]?.length ?? 0;
    },
    onTaskError: (targetId, error) => {
      failedChunks += 1;
      failedUrls += chunks[Number(targetId)]?.length ?? 0;
      if (error.kind !== 'cancelled') reportError(error, 'health', { toast: failedChunks === 1 });
    },
    onTaskSettled: (targetId) => {
      const index = Number(targetId);
      trackHosts(index, -1);
      inFlight.delete(index);
      current?.activeRunIds.delete(chunkRunId(scanId, index));
      publish();
    },
  });
  current = { scanId, activeRunIds: new Set(), queue, cancelled: false };
  const run = current;
  publish.flush();

  let unlisten: (() => void) | null = null;
  try {
    unlisten = await onHealthScanProgress((event) => {
      // Only running chunks count; events of finished chunks arrive late sometimes.
      if (!run.activeRunIds.has(event.runId)) return;
      const index = Number(event.runId.slice(scanId.length + 1));
      const chunk = inFlight.get(index);
      if (!chunk) return;
      chunk.processed = Math.max(chunk.processed, event.processed);
      publish();
    });
  } catch (error) {
    // Progress events are a nicety; the scan still works without them.
    reportError(error, 'health.progress', { toast: false });
  }

  try {
    // Stop pressed while the listener was being set up: the queue was idle, so nothing stopped.
    if (!run.cancelled) {
      queue.add(
        chunks.map((chunk, index) => ({
          targetId: String(index),
          run: () => checkLinksHealth(chunk, chunkRunId(scanId, index)),
        })),
      );
    }
    await queue.whenIdle();

    state = run.cancelled ? 'cancelled' : 'done';
    if (completedUrls > 0) store().setHealthMeta({ hasRun: true, lastScanAt: Date.now() });
    publish.flush();

    // Read the translations now: a long scan can outlive a language change.
    const t = getT();
    store().pushToast(
      fmt(run.cancelled ? t.jobs.healthCancelled : t.jobs.healthFinished, {
        dead: counters.dead,
        protected: counters.protected,
        uncertain: counters.uncertain,
      }),
      counters.dead > 0 ? 'info' : 'success',
    );
  } finally {
    // Whatever went wrong above, the next scan must be able to start.
    current = null;
    unlisten?.();
  }
};

export const cancelHealthScan = (): void => {
  const run = current;
  if (!run || run.cancelled) return;
  run.cancelled = true;
  // Rust resolves each chunk in flight with the results gathered so far.
  for (const runId of run.activeRunIds) {
    cancelHealthScanIpc(runId).catch((error: unknown) => reportError(error, 'health.cancel'));
  }
  run.queue.cancel();
};

/** Test helper: drops a scan that is still registered as running. */
export const resetHealthScanForTests = (): void => {
  current?.queue.cancel();
  current = null;
};
