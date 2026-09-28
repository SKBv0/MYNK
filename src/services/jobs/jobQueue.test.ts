import { describe, expect, it, vi } from 'vitest';
import { IpcError } from '../ipc';
import { JobQueue, backoffDelay, isTransientError, type QueueProgress } from './jobQueue';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const noSleep = () => Promise.resolve();

describe('JobQueue', () => {
  it('respects the concurrency limit', async () => {
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const queue = new JobQueue<void>({ concurrency: 2, throttleMs: 0 });
    queue.add(
      gates.map((gate, i) => ({
        targetId: `t${i}`,
        run: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await gate.promise;
          running -= 1;
        },
      })),
    );
    await flush();
    expect(running).toBe(2);
    gates.forEach((gate) => gate.resolve());
    const final = await queue.whenIdle();
    expect(peak).toBe(2);
    expect(final).toMatchObject({ state: 'done', total: 5, done: 5, failed: 0 });
  });

  it('deduplicates targets that are queued or running', async () => {
    const gate = deferred<void>();
    const run = vi.fn(() => gate.promise);
    const queue = new JobQueue<void>({ concurrency: 1, throttleMs: 0 });
    expect(
      queue.add([
        { targetId: 'a', run },
        { targetId: 'a', run },
      ]),
    ).toBe(1);
    await flush();
    expect(queue.add([{ targetId: 'a', run }])).toBe(0);
    expect(queue.has('a')).toBe(true);
    gate.resolve();
    await queue.whenIdle();
    expect(run).toHaveBeenCalledTimes(1);
    // Once finished, the same target can be queued again.
    expect(queue.add([{ targetId: 'a', run }])).toBe(1);
    await queue.whenIdle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancel drops queued tasks, aborts running ones and reports cancelled', async () => {
    const gate = deferred<string>();
    const seen: AbortSignal[] = [];
    const second = vi.fn(() => Promise.resolve('never'));
    const queue = new JobQueue<string>({ concurrency: 1, throttleMs: 0 });
    queue.add([
      {
        targetId: 'first',
        run: (signal) => {
          seen.push(signal);
          return gate.promise;
        },
      },
      { targetId: 'second', run: second },
    ]);
    await flush();
    queue.cancel();
    expect(seen[0]?.aborted).toBe(true);
    gate.resolve('late result');
    const final = await queue.whenIdle();
    expect(second).not.toHaveBeenCalled();
    expect(final.state).toBe('cancelled');
    expect(queue.add([{ targetId: 'x', run: second }])).toBe(0);
  });

  it('pauses and resumes', async () => {
    const order: string[] = [];
    const queue = new JobQueue<void>({ concurrency: 1, throttleMs: 0 });
    const gate = deferred<void>();
    queue.add([
      {
        targetId: 'a',
        run: async () => {
          order.push('a');
          await gate.promise;
        },
      },
      {
        targetId: 'b',
        run: () => {
          order.push('b');
          return Promise.resolve();
        },
      },
    ]);
    await flush();
    queue.pause();
    gate.resolve();
    await flush();
    expect(order).toEqual(['a']);
    expect(queue.progress.state).toBe('paused');
    queue.resume();
    await queue.whenIdle();
    expect(order).toEqual(['a', 'b']);
  });

  it('retries transient errors with exponential backoff + jitter (max 2 retries)', async () => {
    const sleep = vi.fn((_ms: number, _signal: AbortSignal) => Promise.resolve());
    const run = vi.fn(() => Promise.reject(new IpcError('timeout', 'slow')));
    const onTaskError = vi.fn();
    const queue = new JobQueue<void>({
      concurrency: 1,
      throttleMs: 0,
      baseDelayMs: 1000,
      sleep,
      random: () => 0.5,
      onTaskError,
    });
    queue.add([{ targetId: 'a', run }]);
    const final = await queue.whenIdle();
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([750, 1500]);
    expect(final).toMatchObject({ failed: 1, errorsByKind: { timeout: 1 } });
    expect(onTaskError).toHaveBeenCalledWith('a', expect.objectContaining({ kind: 'timeout' }));
  });

  it('reports a cancel during the retry delay as cancelled, not as the failure that led to it', async () => {
    const onTaskError = vi.fn();
    const queue = new JobQueue<void>({
      concurrency: 1,
      throttleMs: 0,
      sleep: (_ms, signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve())),
      onTaskError,
    });
    queue.add([{ targetId: 'a', run: () => Promise.reject(new IpcError('timeout', 'slow')) }]);
    await flush();

    queue.cancel();
    const final = await queue.whenIdle();

    expect(onTaskError).toHaveBeenCalledWith('a', expect.objectContaining({ kind: 'cancelled' }));
    expect(final).toMatchObject({ failed: 1, errorsByKind: { cancelled: 1 } });
  });

  it('succeeds after a transient failure', async () => {
    let calls = 0;
    const onTaskSuccess = vi.fn();
    const queue = new JobQueue<string>({
      concurrency: 1,
      throttleMs: 0,
      sleep: noSleep,
      onTaskSuccess,
    });
    queue.add([
      {
        targetId: 'a',
        run: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new IpcError('network', 'reset'))
            : Promise.resolve('ok');
        },
      },
    ]);
    const final = await queue.whenIdle();
    expect(final).toMatchObject({ done: 1, failed: 0 });
    expect(onTaskSuccess).toHaveBeenCalledWith('a', 'ok');
  });

  it.each(['cancelled', 'config', 'desktopOnly'] as const)(
    'never retries %s errors',
    async (kind) => {
      const run = vi.fn(() => Promise.reject(new IpcError(kind, kind)));
      const queue = new JobQueue<void>({ concurrency: 1, throttleMs: 0, sleep: noSleep });
      queue.add([{ targetId: 'a', run }]);
      await queue.whenIdle();
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it('runs a dead link once instead of three times', async () => {
    const dead = new IpcError('network', 'Could not fetch the page: the host x.invalid …');
    dead.code = 'hostNotFound';
    const run = vi.fn(() => Promise.reject(dead));
    const queue = new JobQueue<void>({ concurrency: 1, throttleMs: 0, sleep: noSleep });
    queue.add([{ targetId: 'a', run }]);
    const final = await queue.whenIdle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(final).toMatchObject({ failed: 1, errorsByKind: { network: 1 } });
  });

  it('throttles progress callbacks but always emits the final state', async () => {
    vi.useFakeTimers();
    try {
      const events: QueueProgress[] = [];
      const queue = new JobQueue<void>({
        concurrency: 10,
        throttleMs: 250,
        onProgress: (p) => events.push(p),
      });
      queue.add(Array.from({ length: 50 }, (_, i) => ({ targetId: `t${i}`, run: async () => {} })));
      await vi.runAllTimersAsync();
      const final = await queue.whenIdle();
      expect(final.state).toBe('done');
      expect(events.length).toBeLessThan(10);
      expect(events.at(-1)?.state).toBe('done');
      expect(events.at(-1)?.done).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('JobQueue pick', () => {
  it('starts the task `pick` chooses and falls back to FIFO for a bad index or a throw', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const started: string[] = [];
    const answers = [2, 99, Number.NaN];
    const queue = new JobQueue<void>({
      concurrency: 1,
      throttleMs: 0,
      pick: () => {
        const answer = answers.shift();
        if (answer === undefined) throw new Error('no preference');
        return answer;
      },
    });
    queue.add(
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({
        targetId: id,
        run: () => {
          started.push(id);
          return Promise.resolve();
        },
      })),
    );
    await queue.whenIdle();
    expect(started).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(queue.progress).toMatchObject({ state: 'done', done: 5 });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('JobQueue callback failures', () => {
  it('keeps running when onTaskStart throws and still resolves whenIdle', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = vi.fn(() => Promise.resolve('ok'));
    const queue = new JobQueue<string>({
      concurrency: 1,
      throttleMs: 0,
      onTaskStart: () => {
        throw new Error('start blew up');
      },
    });
    queue.add([
      { targetId: 'a', run },
      { targetId: 'b', run },
    ]);
    const final = await queue.whenIdle();
    expect(final).toMatchObject({ state: 'done', total: 2, done: 2, failed: 0, running: 0 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not count a task as failed when onTaskSuccess throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onTaskError = vi.fn();
    const queue = new JobQueue<string>({
      concurrency: 2,
      throttleMs: 0,
      sleep: noSleep,
      onTaskSuccess: () => {
        throw new Error('success handler blew up');
      },
      onTaskError,
    });
    queue.add([
      { targetId: 'a', run: () => Promise.resolve('ok') },
      { targetId: 'b', run: () => Promise.resolve('ok') },
    ]);
    const final = await queue.whenIdle();
    expect(final).toMatchObject({ done: 2, failed: 0 });
    expect(final.done + final.failed).toBeLessThanOrEqual(final.total);
    expect(onTaskError).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('pumps the next task even when onTaskSettled, onTaskError and onProgress throw', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = () => {
      throw new Error('observer blew up');
    };
    const queue = new JobQueue<string>({
      concurrency: 1,
      throttleMs: 0,
      maxRetries: 0,
      onTaskSettled: boom,
      onTaskError: boom,
      onProgress: boom,
    });
    queue.add([
      { targetId: 'a', run: () => Promise.reject(new IpcError('parse', 'bad')) },
      { targetId: 'b', run: () => Promise.resolve('ok') },
    ]);
    const final = await queue.whenIdle();
    expect(final).toMatchObject({ state: 'done', total: 2, done: 1, failed: 1 });
    error.mockRestore();
  });
});

describe('JobQueue scale', () => {
  it('adds 10 000 tasks quickly and deduplicates in constant time', async () => {
    const gate = deferred<void>();
    const queue = new JobQueue<void>({ concurrency: 1, throttleMs: 0 });
    const tasks = Array.from({ length: 10_000 }, (_, i) => ({
      targetId: `t${i}`,
      run: () => gate.promise,
    }));
    const started = performance.now();
    expect(queue.add(tasks)).toBe(10_000);
    expect(queue.add(tasks)).toBe(0);
    const elapsed = performance.now() - started;
    // Only an O(n) dedup scan stays this fast at 10,000 tasks.
    expect(elapsed).toBeLessThan(500);
    expect(queue.has('t9999')).toBe(true);
    expect(queue.has('t0')).toBe(true);
    queue.cancel();
    gate.resolve();
    await queue.whenIdle();
    expect(queue.has('t9999')).toBe(false);
  });

  it('runs every task of a large batch exactly once in FIFO order', async () => {
    const order: number[] = [];
    const queue = new JobQueue<void>({ concurrency: 3, throttleMs: 0 });
    queue.add(
      Array.from({ length: 3000 }, (_, i) => ({
        targetId: `t${i}`,
        run: () => {
          order.push(i);
          return Promise.resolve();
        },
      })),
    );
    const final = await queue.whenIdle();
    expect(final).toMatchObject({ state: 'done', done: 3000 });
    expect(order).toEqual(Array.from({ length: 3000 }, (_, i) => i));
  });
});

describe('queueing at the front', () => {
  it('runs a front-queued task before everything already waiting', async () => {
    const started: string[] = [];
    const gate = deferred<void>();
    const queue = new JobQueue<void>({ concurrency: 1, throttleMs: 0 });
    queue.add([
      { targetId: 'blocker', run: () => gate.promise },
      ...['a', 'b', 'c'].map((id) => ({
        targetId: id,
        run: () => {
          started.push(id);
          return Promise.resolve();
        },
      })),
    ]);
    queue.add(
      [
        {
          targetId: 'urgent',
          run: () => {
            started.push('urgent');
            return Promise.resolve();
          },
        },
      ],
      { front: true },
    );

    gate.resolve();
    await queue.whenIdle();
    expect(started).toEqual(['urgent', 'a', 'b', 'c']);
  });

  it('front-queues a batch larger than a call frame holds, ahead of the waiting tasks', async () => {
    const gate = deferred<void>();
    const order: string[] = [];
    const queue = new JobQueue<void>({ concurrency: 1, throttleMs: 0 });
    const task = (id: string) => ({
      targetId: id,
      run: () => {
        order.push(id);
        return Promise.resolve();
      },
    });
    queue.add([{ targetId: 'blocker', run: () => gate.promise }, task('tail')]);
    const batch = Array.from({ length: 200_000 }, (_, i) => task(`f${i}`));
    expect(queue.add(batch, { front: true })).toBe(200_000);

    gate.resolve();
    await queue.whenIdle();
    expect(order[0]).toBe('f0');
    expect(order.at(-1)).toBe('tail');
  });

  it('ignores a front task whose target is already queued', async () => {
    const gate = deferred<void>();
    const queue = new JobQueue<void>({ concurrency: 1, throttleMs: 0 });
    queue.add([
      { targetId: 'blocker', run: () => gate.promise },
      { targetId: 'a', run: () => Promise.resolve() },
    ]);
    expect(queue.add([{ targetId: 'a', run: () => Promise.resolve() }], { front: true })).toBe(0);

    gate.resolve();
    const final = await queue.whenIdle();
    expect(final.total).toBe(2);
  });
});

describe('retry policy helpers', () => {
  it('classifies transient errors', () => {
    expect(isTransientError(new IpcError('network', ''))).toBe(true);
    expect(isTransientError(new IpcError('timeout', ''))).toBe(true);
    expect(isTransientError(new IpcError('provider', '', 503))).toBe(true);
    expect(isTransientError(new IpcError('provider', '', 429))).toBe(true);
    expect(isTransientError(new IpcError('provider', '', 401))).toBe(false);
    expect(isTransientError(new IpcError('parse', ''))).toBe(false);
    expect(isTransientError(new IpcError('config', ''))).toBe(false);
  });

  it('does not retry a network error that names an unreachable Ollama', () => {
    const unreachable = new IpcError('network', '');
    unreachable.code = 'ollamaUnreachable';
    expect(isTransientError(unreachable)).toBe(false);
  });

  it.each(['hostNotFound', 'tlsCertificate', 'tlsHandshake'] as const)(
    'does not retry a dead link the backend classified as %s',
    (code) => {
      const dead = new IpcError('network', 'Could not fetch the page: …');
      dead.code = code;
      expect(isTransientError(dead)).toBe(false);
    },
  );

  it('computes bounded exponential delays', () => {
    expect(backoffDelay(0, 1000, 30_000, () => 0)).toBe(500);
    expect(backoffDelay(0, 1000, 30_000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 30_000, () => 1)).toBe(8000);
    expect(backoffDelay(10, 1000, 30_000, () => 1)).toBe(30_000);
  });
});
