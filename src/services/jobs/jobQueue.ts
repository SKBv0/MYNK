/**
 * Generic background job queue: concurrency limit, pause/resume/cancel (AbortSignal), one task per
 * target at a time, backoff retries for transient errors only, throttled progress. A callback
 * exception is logged and never stalls the queue.
 */
import { IpcError, toIpcError } from '../ipc';
import type { AppErrorCode, AppErrorKind } from '../ipcTypes';

export type QueueState = 'idle' | 'running' | 'paused' | 'cancelled' | 'done';

export interface QueueProgress {
  state: QueueState;
  total: number;
  done: number;
  failed: number;
  running: number;
  errorsByKind: Partial<Record<AppErrorKind, number>>;
}

export interface JobTask<T> {
  /** Target identifier; a target can only be queued/running once. */
  targetId: string;
  run: (signal: AbortSignal) => Promise<T>;
}

export interface JobQueueOptions<T> {
  concurrency: number;
  maxRetries?: number;
  /** Injectable for tests. */
  baseDelayMs?: number;
  throttleMs?: number;
  onProgress?: (progress: QueueProgress) => void;
  onTaskStart?: (targetId: string) => void;
  onTaskSuccess?: (targetId: string, result: T) => void;
  /** Called for the final failure of a task (after retries). */
  onTaskError?: (targetId: string, error: IpcError) => void;
  /** Called after every task, success or failure. */
  onTaskSettled?: (targetId: string) => void;
  /** Index of the queued task to start next (default 0, FIFO); out-of-range values mean 0. */
  pick?: (pending: readonly JobTask<T>[]) => number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

const MAX_RETRY_DELAY_MS = 30_000;

const NEVER_RETRY = new Set<AppErrorKind>(['cancelled', 'config', 'desktopOnly']);

/**
 * Network failures whose cause is fixed for the whole run: a setup problem, a name that does
 * not exist, a certificate or protocol the site itself serves. Every attempt ends the same way.
 */
const NEVER_RETRY_CODES = new Set<AppErrorCode>([
  'ollamaUnreachable',
  'hostNotFound',
  'tlsCertificate',
  'tlsHandshake',
]);

export const isTransientError = (error: IpcError): boolean => {
  if (NEVER_RETRY.has(error.kind)) return false;
  if (error.code !== undefined && NEVER_RETRY_CODES.has(error.code)) return false;
  if (error.kind === 'network' || error.kind === 'timeout') return true;
  if (error.kind === 'provider') {
    return error.status === undefined || error.status === 429 || error.status >= 500;
  }
  return false;
};

export const backoffDelay = (
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number => {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  // "Equal jitter": half fixed, half random.
  return Math.round(exponential / 2 + (random() * exponential) / 2);
};

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });

export class JobQueue<T> {
  private readonly options: Required<
    Pick<JobQueueOptions<T>, 'maxRetries' | 'baseDelayMs' | 'throttleMs'>
  > &
    JobQueueOptions<T>;
  /** FIFO of queued tasks; `head` avoids the O(n) `Array.shift`. */
  private pending: JobTask<T>[] = [];
  private head = 0;
  private readonly pendingIds = new Set<string>();
  private readonly active = new Set<string>();
  private readonly controller = new AbortController();
  private state: QueueState = 'idle';
  private total = 0;
  private done = 0;
  private failed = 0;
  private errorsByKind: Partial<Record<AppErrorKind, number>> = {};
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private idleWaiters: ((progress: QueueProgress) => void)[] = [];

  constructor(options: JobQueueOptions<T>) {
    this.options = {
      maxRetries: 2,
      baseDelayMs: 1000,
      throttleMs: 250,
      ...options,
    };
  }

  get progress(): QueueProgress {
    return {
      state: this.state,
      total: this.total,
      done: this.done,
      failed: this.failed,
      running: this.active.size,
      errorsByKind: { ...this.errorsByKind },
    };
  }

  get isActive(): boolean {
    return this.state === 'running' || this.state === 'paused';
  }

  /** True while the target is queued or running. */
  has(targetId: string): boolean {
    return this.active.has(targetId) || this.pendingIds.has(targetId);
  }

  /**
   * Adds tasks (duplicates of queued/running targets are ignored). Returns the number added.
   * `front` puts them ahead of everything queued, for a caller that waits on their result.
   */
  add(tasks: JobTask<T>[], options?: { front?: boolean }): number {
    if (this.state === 'cancelled') return 0;
    const fresh: JobTask<T>[] = [];
    for (const task of tasks) {
      if (this.has(task.targetId)) continue;
      fresh.push(task);
      this.pendingIds.add(task.targetId);
    }
    const added = fresh.length;
    if (added === 0) return 0;
    // No spreads: a bulk import hands over more arguments than a call frame holds.
    if (options?.front) {
      this.pending = fresh.concat(this.pending.slice(this.head));
      this.head = 0;
    } else {
      for (const task of fresh) this.pending.push(task);
    }
    this.total += added;
    if (this.state === 'idle' || this.state === 'done') this.state = 'running';
    this.emit(true);
    this.pump();
    return added;
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.emit(true);
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.emit(true);
    this.pump();
  }

  /** Drops queued tasks and aborts running ones. In-flight results are still reported. */
  cancel(): void {
    if (this.state === 'cancelled' || this.state === 'done' || this.state === 'idle') return;
    this.state = 'cancelled';
    this.clearPending();
    this.controller.abort();
    this.emit(true);
    if (this.active.size === 0) this.resolveIdle();
  }

  /** Resolves when no task is queued or running anymore. */
  whenIdle(): Promise<QueueProgress> {
    if (this.active.size === 0 && (this.pendingCount === 0 || this.state === 'cancelled')) {
      return Promise.resolve(this.progress);
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private get pendingCount(): number {
    return this.pending.length - this.head;
  }

  private clearPending(): void {
    this.pending = [];
    this.head = 0;
    this.pendingIds.clear();
  }

  private takeNext(): JobTask<T> | undefined {
    const pick = this.options.pick;
    let offset = 0;
    if (pick && this.pendingCount > 1) {
      this.guard('pick', () => {
        offset = pick(this.pending.slice(this.head));
      });
    }
    if (Number.isInteger(offset) && offset > 0 && offset < this.pendingCount) {
      const [picked] = this.pending.splice(this.head + offset, 1);
      if (picked) this.pendingIds.delete(picked.targetId);
      return picked;
    }
    const task = this.pending[this.head];
    if (!task) return undefined;
    this.head += 1;
    this.pendingIds.delete(task.targetId);
    if (this.head === this.pending.length) {
      this.clearPending();
    } else if (this.head >= 1024 && this.head * 2 >= this.pending.length) {
      // Compact once the consumed prefix dominates, keeping memory bounded.
      this.pending = this.pending.slice(this.head);
      this.head = 0;
    }
    return task;
  }

  /** Runs an observer callback; its exception is logged and never escapes into the queue. */
  private guard(name: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      console.error(`[MYNK] job queue: ${name} callback threw`, error);
    }
  }

  private pump(): void {
    while (
      this.state === 'running' &&
      this.active.size < this.options.concurrency &&
      this.pendingCount > 0
    ) {
      const task = this.takeNext();
      if (!task) break;
      this.active.add(task.targetId);
      void this.execute(task);
    }
    if (this.active.size === 0 && this.pendingCount === 0 && this.state === 'running') {
      this.state = 'done';
      this.emit(true);
      this.resolveIdle();
    }
  }

  private async execute(task: JobTask<T>): Promise<void> {
    const { signal } = this.controller;
    const { targetId } = task;
    let attempt = 0;
    try {
      this.guard('onTaskStart', () => this.options.onTaskStart?.(targetId));
      for (;;) {
        let result: T;
        try {
          result = await task.run(signal);
        } catch (raw) {
          let error = toIpcError(raw);
          const retryable = isTransientError(error);
          if (retryable && attempt < this.options.maxRetries && !signal.aborted) {
            const delay = backoffDelay(
              attempt,
              this.options.baseDelayMs,
              MAX_RETRY_DELAY_MS,
              this.options.random ?? Math.random,
            );
            attempt += 1;
            try {
              await (this.options.sleep ?? defaultSleep)(delay, signal);
            } catch (sleepError) {
              console.error('[MYNK] job queue: retry delay failed', sleepError);
            }
            if (!signal.aborted) continue;
            // Cancelled while waiting: report the cancel, not the transient error.
            error = new IpcError('cancelled', 'The task was cancelled.');
          }
          this.failed += 1;
          this.errorsByKind[error.kind] = (this.errorsByKind[error.kind] ?? 0) + 1;
          this.guard('onTaskError', () => this.options.onTaskError?.(targetId, error));
          return;
        }
        // Outside the catch above: a throwing success callback must not count as a failure.
        this.done += 1;
        this.guard('onTaskSuccess', () => this.options.onTaskSuccess?.(targetId, result));
        return;
      }
    } finally {
      this.active.delete(targetId);
      this.guard('onTaskSettled', () => this.options.onTaskSettled?.(targetId));
      this.emit(false);
      if (this.state === 'cancelled') {
        if (this.active.size === 0) this.resolveIdle();
      } else {
        this.pump();
      }
    }
  }

  private emit(immediate: boolean): void {
    const onProgress = this.options.onProgress;
    if (!onProgress) return;
    const now = Date.now();
    const throttle = this.options.throttleMs;
    if (immediate || throttle <= 0 || now - this.lastEmit >= throttle) {
      if (this.emitTimer !== null) {
        clearTimeout(this.emitTimer);
        this.emitTimer = null;
      }
      this.lastEmit = now;
      this.guard('onProgress', () => onProgress(this.progress));
      return;
    }
    if (this.emitTimer === null) {
      this.emitTimer = setTimeout(
        () => {
          this.emitTimer = null;
          this.lastEmit = Date.now();
          this.guard('onProgress', () => onProgress(this.progress));
        },
        throttle - (now - this.lastEmit),
      );
    }
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    const progress = this.progress;
    for (const resolve of waiters) resolve(progress);
  }
}
