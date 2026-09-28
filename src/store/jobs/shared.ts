import type { JobKind, JobProgress, JobState } from '../../types';
import type { JobQueue, QueueProgress } from '../../services/jobs/jobQueue';
import { getT, useAppStore } from '../index';

export const FINISHED_VISIBLE_MS = 5000;

const hideTimers = new Map<JobKind, ReturnType<typeof setTimeout>>();

/** A paused job still counts as active: it holds its queue and the user can resume it. */
export const isJobActive = (job: JobProgress | null | undefined): boolean =>
  job?.state === 'running' || job?.state === 'paused';

export const toJobState = (state: QueueProgress['state']): JobState => {
  if (state === 'paused') return 'paused';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'done' || state === 'idle') return 'done';
  return 'running';
};

/** Writes job progress to the store (the queue already throttles its callbacks). */
export const publishJob = (
  kind: JobKind,
  startedAt: number,
  values: { state: JobState; total: number; done: number; failed: number },
  counters: Record<string, number> = {},
): void => {
  // A cancelled run's throttled last update can arrive after a newer run has started.
  const current = useAppStore.getState().jobs[kind];
  if (current && current.startedAt > startedAt) return;
  const timer = hideTimers.get(kind);
  if (timer !== undefined) {
    clearTimeout(timer);
    hideTimers.delete(kind);
  }
  const finished = values.state === 'done' || values.state === 'cancelled';
  const progress: JobProgress = {
    kind,
    state: values.state,
    total: values.total,
    done: values.done,
    failed: values.failed,
    startedAt,
    finishedAt: finished ? Date.now() : null,
    counters: { ...counters },
  };
  useAppStore.getState().setJob(kind, progress);
  if (finished) {
    hideTimers.set(
      kind,
      setTimeout(() => {
        hideTimers.delete(kind);
        const current = useAppStore.getState().jobs[kind];
        if (current && current.startedAt === startedAt && current.finishedAt !== null) {
          useAppStore.getState().setJob(kind, null);
        }
      }, FINISHED_VISIBLE_MS),
    );
  }
};

/**
 * A new run waits for a cancelled run's in-flight tasks to settle, so late callbacks cannot
 * overwrite its state; `release` clears the module's queue slot while it holds the retired queue.
 */
export const drainRetiredQueue = async <T>(
  current: () => JobQueue<T> | null,
  release: (retired: JobQueue<T>) => void,
): Promise<void> => {
  const pending = current();
  // Only worth saying when the cancelled run still has an item in flight to wait for.
  if (pending && !pending.isActive && pending.progress.running > 0) {
    useAppStore.getState().pushToast(getT().jobs.waitingForCancelledRun, 'info');
  }
  for (let retiring = current(); retiring && !retiring.isActive; retiring = current()) {
    await retiring.whenIdle();
    release(retiring);
  }
};

/** Test helper: cancels the pending "hide finished job" timers. */
export const resetJobHudForTests = (): void => {
  for (const timer of hideTimers.values()) clearTimeout(timer);
  hideTimers.clear();
};

/** Hides a job card immediately (user dismissed it). */
export const dismissJob = (kind: JobKind): void => {
  const current = useAppStore.getState().jobs[kind];
  if (current && current.state !== 'running' && current.state !== 'paused') {
    useAppStore.getState().setJob(kind, null);
  }
};

/** Trailing throttle for event-driven progress (health scan events). */
export const throttle = (fn: () => void, ms: number): (() => void) & { flush: () => void } => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  const run = () => {
    timer = null;
    last = Date.now();
    fn();
  };
  const throttled = () => {
    const wait = ms - (Date.now() - last);
    if (wait <= 0) run();
    else if (timer === null) timer = setTimeout(run, wait);
  };
  throttled.flush = () => {
    if (timer !== null) clearTimeout(timer);
    run();
  };
  return throttled;
};
