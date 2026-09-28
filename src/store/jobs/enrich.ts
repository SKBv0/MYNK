/**
 * Bulk AI enrichment queue (concurrency 2). Cancelling a run also cancels its in-flight
 * requests in Rust via `cancelRequest`, dropping their HTTP connections.
 */
import { analyzeUrl, cancelRequest, getAiSettings } from '../../services/aiService';
import { IpcError, isDesktopRuntime, toIpcError } from '../../services/ipc';
import type { AnalyzeResult, AppErrorCode } from '../../services/ipcTypes';
import { JobQueue, type QueueProgress } from '../../services/jobs/jobQueue';
import type { AiSetupNotice, AiSetupReason, Resource, ResourceAi } from '../../types';
import { errorMessage, reportError } from '../../lib/errors';
import { fmt } from '../../lib/text';
import { newId } from '../../lib/id';
import { looksLikeUrl } from '../../lib/url';
import { getT, useAppStore } from '../index';
import { needsAnalysis, resourceById } from '../selectors';
import { drainRetiredQueue, publishJob, toJobState } from './shared';
import { queueMediaCache } from './media';

export const ENRICH_CONCURRENCY = 2;

/** `done` counts every processed record; user-cancelled analyses count as neither. */
export const enrichCounts = (p: QueueProgress): { total: number; done: number; failed: number } => {
  const failed = p.failed - (p.errorsByKind.cancelled ?? 0);
  return { total: p.total, done: p.done + failed, failed };
};

/** Never-analyzed records first, failures last, so a retrying record can't delay first progress. */
export const orderEnrichTargets = (targets: Resource[]): Resource[] => [
  ...targets.filter((r) => r.ai.status !== 'failed'),
  ...targets.filter((r) => r.ai.status === 'failed'),
];

let queue: JobQueue<AnalyzeResult> | null = null;
let stopNotified = false;
/** A run stopped for a missing AI setup: the settings offer explains it, a count toast would not. */
let setupRedirected = false;
/** The running queue holds only runs the user did not start. */
let backgroundRun = false;
/** What the running queue was asked to analyze, so a setup notice can continue the same run. */
let runTargets: string[] | 'all' = [];
/** Background runs repeat every poll, so their setup toast is shown once per app session. */
let backgroundSetupToastShown = false;

const store = () => useAppStore.getState();

/** The AI status a record had before a run queued it. */
type PriorAi = Pick<ResourceAi, 'status' | 'error'>;

/** Per-run memory of prior AI statuses, restored on cancel instead of showing "never analyzed". */
const priorAi = new WeakMap<JobQueue<AnalyzeResult>, Map<string, PriorAi>>();

/** `updatedAt` each record had when its analysis started; a newer one means the user edited it. */
const baseUpdatedAt = new Map<string, number>();

/** Callers waiting for one record instead of for the whole run (see `startEnrichment`). */
const settleWaiters = new Map<string, (() => void)[]>();

const resolveSettled = (ids: Iterable<string>): void => {
  for (const id of [...ids]) {
    const waiters = settleWaiters.get(id);
    if (!waiters) continue;
    settleWaiters.delete(id);
    for (const resolve of waiters) resolve();
  }
};

/** Resolves when this record has settled, or when the run ended without ever reaching it. */
const whenSettled = (id: string): Promise<void> =>
  new Promise((resolve) => {
    settleWaiters.set(id, [...(settleWaiters.get(id) ?? []), resolve]);
  });

const snapshotAi = (ai: ResourceAi): PriorAi =>
  ai.error === undefined ? { status: ai.status } : { status: ai.status, error: ai.error };

/** Puts the remembered status back (a remembered "pending" was never a finished state). */
const restorePriorStatus = (q: JobQueue<AnalyzeResult>, ids: string[]): void => {
  const prior = priorAi.get(q);
  for (const id of ids) {
    const before = prior?.get(id);
    prior?.delete(id);
    const status = !before || before.status === 'pending' ? 'none' : before.status;
    store().setAiStatus([id], status, before?.error);
  }
};

/** Error codes that name an AI setup problem; the others say nothing about the provider. */
type SetupCode = Extract<AppErrorCode, AiSetupReason>;
const SETUP_CODES = new Set<AppErrorCode>(['ollamaUnreachable', 'modelMissing', 'notChatModel']);

const isSetupCode = (code: AppErrorCode | undefined): code is SetupCode =>
  code !== undefined && SETUP_CODES.has(code);

/** The AI provider itself is unusable, so no bookmark in the run could have succeeded. */
const setupNotice = (error: IpcError, targets: string[] | 'all'): AiSetupNotice | null => {
  if (isSetupCode(error.code)) {
    return error.model === undefined
      ? { reason: error.code, targets }
      : { reason: error.code, model: error.model, targets };
  }
  if (error.kind === 'keyring') return { reason: 'keyring', targets };
  if (error.kind === 'config') return { reason: 'notConfigured', targets };
  return null;
};

/**
 * Offers the AI settings instead of blaming the bookmark. The page stays where the user is: a
 * first-time user who adds a link wants to see the card, not be moved to Settings.
 */
const askForAiSetup = (notice: AiSetupNotice, background: boolean): void => {
  // Background runs repeat every poll, so they offer the settings once per session.
  if (background) {
    if (backgroundSetupToastShown) return;
    backgroundSetupToastShown = true;
  }
  const t = getT();
  store().pushToast(t.jobs.aiSetupNeeded, 'info', {
    action: { label: t.jobs.openAiSettings, run: () => store().openSettings('ai', notice) },
  });
};

const createQueue = (): JobQueue<AnalyzeResult> => {
  const runStartedAt = Date.now();
  stopNotified = false;
  setupRedirected = false;
  runTargets = [];
  const q: JobQueue<AnalyzeResult> = new JobQueue<AnalyzeResult>({
    concurrency: ENRICH_CONCURRENCY,
    onProgress: (p) =>
      publishJob('enrich', runStartedAt, { state: toJobState(p.state), ...enrichCounts(p) }),
    onTaskStart: (id) => {
      const current = resourceById(store().resources, id);
      if (current) baseUpdatedAt.set(id, current.updatedAt);
      store().setAiStatus([id], 'pending');
      store().setBusy('enrich', id, true);
    },
    onTaskSuccess: (id, result) => {
      priorAi.get(q)?.delete(id);
      if (runTargets !== 'all') runTargets = runTargets.filter((target) => target !== id);
      const analyzed = resourceById(store().resources, id);
      // A login or consent wall also "redirects"; only a page that was read names a target.
      if (analyzed) {
        store().noteFinalUrls([
          {
            url: analyzed.url,
            finalUrl: result.insufficientContent ? undefined : result.finalUrl,
          },
        ]);
      }
      store().applyAnalysis(id, result, baseUpdatedAt.get(id));
      void queueMediaCache([id]);
    },
    onTaskError: (id, error) => {
      if (error.kind === 'notFound' && !store().resources.some((r) => r.id === id)) {
        priorAi.get(q)?.delete(id);
        return;
      }
      if (error.kind === 'cancelled') {
        // Restore the pre-run status so an analyzed bookmark isn't marked "never analyzed".
        restorePriorStatus(q, [id]);
        return;
      }
      const notice = setupNotice(error, runTargets);
      if (notice) {
        // A missing AI setup is not this bookmark's fault, so its status must survive the run.
        q.cancel();
        restorePriorStatus(q, [id]);
        setupRedirected = true;
        if (!stopNotified) {
          stopNotified = true;
          reportError(error, 'enrich.setup', { toast: false });
          askForAiSetup(notice, backgroundRun);
        }
        return;
      }
      priorAi.get(q)?.delete(id);
      store().setAiStatus([id], 'failed', errorMessage(error));
      if (error.kind === 'desktopOnly') {
        // Every other item would fail the same way: stop and tell the user once.
        q.cancel();
        if (!stopNotified) {
          stopNotified = true;
          reportError(error, 'enrich', { prefix: getT().jobs.enrichStopped });
        }
        return;
      }
      if (q.progress.total === 1) {
        const resource = resourceById(store().resources, id);
        reportError(error, 'enrich', {
          prefix: fmt(getT().jobs.enrichFailedOne, { title: resource?.title ?? '' }),
          action: {
            label: getT().common.retry,
            run: () => void startEnrichment([id]),
          },
        });
      }
    },
    onTaskSettled: (id) => {
      baseUpdatedAt.delete(id);
      store().setBusy('enrich', id, false);
      resolveSettled([id]);
    },
  });
  priorAi.set(q, new Map());
  return q;
};

/** Runs once the queue has drained (attached after the first `add`, see startEnrichment). */
const onQueueIdle = (q: JobQueue<AnalyzeResult>) =>
  void q.whenIdle().then((final) => {
    if (queue === q) queue = null;
    const t = getT();
    // Items that were queued as pending but never ran (cancelled run) go back to their old status.
    const state = store();
    const busy = new Set(state.busy.enrich);
    const stillPending = state.resources
      .filter((r) => r.ai.status === 'pending' && !busy.has(r.id))
      .map((r) => r.id);
    if (stillPending.length > 0) restorePriorStatus(q, stillPending);
    priorAi.delete(q);
    // Targets a cancelled run never reached still have callers waiting on them.
    resolveSettled(settleWaiters.keys());
    if (!setupRedirected && (final.total > 1 || final.state === 'cancelled')) {
      const counts = enrichCounts(final);
      store().pushToast(
        final.state === 'cancelled'
          ? fmt(t.jobs.enrichCancelled, { done: counts.done, total: counts.total })
          : fmt(t.jobs.enrichFinished, { done: final.done, failed: counts.failed }),
        counts.failed > 0 ? 'info' : 'success',
      );
    }
  });

/** Analyzes one resource with a cancellable request tied to the queue's abort signal. */
const analyzeTask = async (id: string, signal: AbortSignal): Promise<AnalyzeResult> => {
  const current = resourceById(store().resources, id);
  if (!current) throw new IpcError('notFound', 'Resource was removed.');
  if (signal.aborted) throw new IpcError('cancelled', 'The analysis was cancelled.');
  const requestId = newId();
  const onAbort = () => {
    cancelRequest(requestId).catch((error: unknown) =>
      reportError(error, 'enrich.cancel', { toast: false }),
    );
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await analyzeUrl(current.url, store().lang, requestId);
    if (result.setupError) {
      // The page was read before the provider failed: a card named after its host gets the
      // page's own title, and the run stops the way any setup error stops it.
      const title = result.title.trim();
      // Read again: the user may have renamed the card while the page was loading.
      const latest = resourceById(store().resources, current.id);
      if (title && latest && !latest.titleEditedByUser && looksLikeUrl(latest.title, latest.url)) {
        store().updateResource(latest.id, { title });
      }
      throw toIpcError(result.setupError);
    }
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

export interface EnrichOptions {
  /**
   * Resolve once these records settle, not the whole queue; they run first. While the run is
   * paused they stay queued and the call resolves at once.
   */
  awaitTargets?: boolean;
  /** Background run: does not navigate or dismiss an open notice. */
  background?: boolean;
}

/** Enriches given resources (or everything needing analysis); joins a running queue if any. */
export const startEnrichment = async (ids?: string[], options?: EnrichOptions): Promise<void> => {
  const t = getT();
  if (!isDesktopRuntime()) {
    store().pushToast(t.errors.desktopOnly, 'info');
    return;
  }
  // A cancelled run's in-flight analyses settle first (Rust cancels them).
  await drainRetiredQueue(
    () => queue,
    (retired) => {
      if (queue === retired) queue = null;
    },
  );
  const resources = store().resources;
  const wanted = ids ? new Set(ids) : null;
  const targets = orderEnrichTargets(
    wanted ? resources.filter((r) => wanted.has(r.id)) : resources.filter((r) => needsAnalysis(r)),
  );
  if (targets.length === 0) {
    store().pushToast(t.jobs.enrichNothing, 'info');
    return;
  }

  const background = options?.background === true;
  if (!background) store().dismissAiSetupNotice();
  const existing = queue?.isActive ? queue : null;
  const q = existing ?? (queue = createQueue());
  // One foreground run is enough to make the whole queue foreground again.
  if (!existing || !background) backgroundRun = background;
  if (!ids) runTargets = 'all';
  else if (runTargets !== 'all')
    runTargets = [...new Set([...runTargets, ...targets.map((r) => r.id)])];
  store().setEnrichInBackground(backgroundRun);
  // Remember what each record looked like before this run touched it (see `restorePriorStatus`).
  const prior = priorAi.get(q);
  for (const target of targets) {
    if (!prior || q.has(target.id) || prior.has(target.id)) continue;
    prior.set(target.id, snapshotAi(target.ai));
  }
  q.add(
    targets.map((target) => ({
      targetId: target.id,
      run: (signal: AbortSignal) => analyzeTask(target.id, signal),
    })),
    // A caller waiting on these records must not queue behind a bulk run of thousands.
    { front: options?.awaitTargets === true },
  );
  // A fresh queue is idle until it has tasks, so the idle handler is attached after `add`.
  if (!existing) onQueueIdle(q);
  if (options?.awaitTargets) {
    if (q.progress.state === 'paused') {
      // Waiting would last until the user resumes; the records keep their queue place instead.
      const busy = new Set(store().busy.enrich);
      const waiting = targets.filter((r) => r.ai.status === 'pending' && !busy.has(r.id));
      if (waiting.length > 0)
        store().setAiStatus(
          waiting.map((r) => r.id),
          'none',
        );
      store().pushToast(t.jobs.enrichQueuedWhilePaused, 'info');
      return;
    }
    await Promise.all(targets.map((target) => whenSettled(target.id)));
    return;
  }
  await q.whenIdle();
};

/** A run longer than this is worth a confirmation: it takes a while and may cost money. */
export const BULK_CONFIRM_THRESHOLD = 200;

/** Whether the stored provider bills per request; false when the setting cannot be read. */
const providerCosts = async (): Promise<boolean> => {
  try {
    return (await getAiSettings()).provider === 'openrouter';
  } catch {
    return false;
  }
};

/** Starts an analysis run; asks for confirmation above the size threshold. */
export const startEnrichmentConfirmed = async (ids?: string[]): Promise<void> => {
  const count = ids ? ids.length : store().resources.filter((r) => needsAnalysis(r)).length;
  if (count <= BULK_CONFIRM_THRESHOLD) {
    await startEnrichment(ids);
    return;
  }
  const t = getT();
  const costs = await providerCosts();
  const message = fmt(t.jobs.bulkConfirmMessage, { count });
  store().requestConfirm({
    title: t.jobs.bulkConfirmTitle,
    message: costs ? `${message} ${t.jobs.bulkConfirmCost}` : message,
    confirmLabel: t.common.start,
    onConfirm: () => void startEnrichment(ids),
  });
};

export const cancelEnrichment = (): void => queue?.cancel();
export const pauseEnrichment = (): void => queue?.pause();
export const resumeEnrichment = (): void => queue?.resume();

/** Test helper: drops the running queue and the once-per-run notification flag. */
export const resetEnrichmentForTests = (): void => {
  queue?.cancel();
  queue = null;
  stopNotified = false;
  setupRedirected = false;
  backgroundRun = false;
  runTargets = [];
  backgroundSetupToastShown = false;
  baseUpdatedAt.clear();
  resolveSettled(settleWaiters.keys());
};
