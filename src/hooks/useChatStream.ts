/** Wraps `chatStream()`; a new `send` cancels the one already running. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { chatStream, type ChatStreamHandle } from '../services/aiService';
import { IpcError, toIpcError } from '../services/ipc';
import type { ChatRequest, ChatStreamEvent, ChatUsage } from '../services/ipcTypes';

export interface ChatStreamState {
  text: string;
  streaming: boolean;
  usage: ChatUsage | null;
  error: IpcError | null;
  /** True when the last stream was stopped by `cancel()` (or a newer `send`). */
  cancelled: boolean;
}

/** Outcome of one `send` run, passed to `SendOptions.onSettled`. */
export interface ChatStreamOutcome {
  /** Full answer, or the partial text of a cancelled / failed stream. */
  text: string;
  usage: ChatUsage | null;
  cancelled: boolean;
  error: IpcError | null;
}

export interface SendOptions {
  /**
   * Called once when this run settles by `done` or `error`; a run stopped by `cancel()`, a newer
   * `send`, `reset()` or unmount settles as cancelled with its partial text.
   */
  onSettled?: (outcome: ChatStreamOutcome) => void;
}

export interface UseChatStreamResult extends ChatStreamState {
  /** Starts streaming; resolves with the full answer, or `null` when cancelled or failed. */
  send: (request: ChatRequest, options?: SendOptions) => Promise<string | null>;
  cancel: () => Promise<void>;
  /** Clears text / usage / error (cancels a running stream first). */
  reset: () => void;
}

export interface UseChatStreamOptions {
  /** Injectable for tests; defaults to the IPC implementation. */
  stream?: typeof chatStream;
}

const INITIAL: ChatStreamState = {
  text: '',
  streaming: false,
  usage: null,
  error: null,
  cancelled: false,
};

export const useChatStream = (options: UseChatStreamOptions = {}): UseChatStreamResult => {
  const streamImpl = options.stream ?? chatStream;
  const [state, setState] = useState<ChatStreamState>(INITIAL);
  const handleRef = useRef<ChatStreamHandle | null>(null);
  /** Reports the running stream as cancelled (with its partial text) to its `onSettled`. */
  const settleCancelRef = useRef<(() => void) | null>(null);
  // Incremented per send / cancel: events and results of older runs are ignored.
  const runRef = useRef(0);
  const mountedRef = useRef(true);

  const stopCurrent = useCallback(() => {
    const handle = handleRef.current;
    const settleCancel = settleCancelRef.current;
    handleRef.current = null;
    settleCancelRef.current = null;
    runRef.current += 1;
    settleCancel?.();
    if (handle) {
      handle.cancel().catch((error: unknown) => {
        console.warn('[MYNK] chat stream cancel failed:', error);
      });
    }
    return handle !== null;
  }, []);

  const send = useCallback(
    async (request: ChatRequest, sendOptions: SendOptions = {}): Promise<string | null> => {
      // A send issued after unmount (e.g. after an awaited lookup) must not start a stream.
      if (!mountedRef.current) return null;
      stopCurrent();
      const run = runRef.current;
      const isCurrent = () => mountedRef.current && runRef.current === run;
      setState({ ...INITIAL, streaming: true });

      // Synchronous mirror of this run's text / usage for `onSettled`.
      let partial = '';
      let usage: ChatUsage | null = null;
      let settled = false;
      const settle = (outcome: ChatStreamOutcome) => {
        if (settled) return;
        settled = true;
        sendOptions.onSettled?.(outcome);
      };
      settleCancelRef.current = () =>
        settle({ text: partial, usage, cancelled: true, error: null });

      const onEvent = (event: ChatStreamEvent) => {
        if (!isCurrent()) return;
        if (event.type === 'delta') {
          partial += event.text;
          setState((s) => ({ ...s, text: s.text + event.text }));
        } else if (event.type === 'done') {
          usage = event.usage ?? null;
          setState((s) => ({ ...s, streaming: false, usage }));
        }
      };

      const handle = streamImpl(request, onEvent);
      handleRef.current = handle;
      try {
        const text = await handle.done;
        if (isCurrent()) {
          handleRef.current = null;
          settleCancelRef.current = null;
          // `done` may resolve before React flushed the last delta; make the final text exact.
          setState((s) => ({ ...s, text, streaming: false }));
          settle({ text, usage, cancelled: false, error: null });
        }
        return text;
      } catch (raw) {
        const error = toIpcError(raw);
        if (isCurrent()) {
          handleRef.current = null;
          settleCancelRef.current = null;
          const cancelled = error.kind === 'cancelled';
          setState((s) => ({
            ...s,
            streaming: false,
            cancelled,
            error: cancelled ? null : error,
          }));
          settle({ text: partial, usage, cancelled, error: cancelled ? null : error });
        }
        return null;
      }
    },
    [streamImpl, stopCurrent],
  );

  const cancel = useCallback(async (): Promise<void> => {
    const handle = handleRef.current;
    if (!handle) return;
    const settleCancel = settleCancelRef.current;
    handleRef.current = null;
    settleCancelRef.current = null;
    runRef.current += 1;
    setState((s) => ({ ...s, streaming: false, cancelled: true }));
    settleCancel?.();
    try {
      await handle.cancel();
    } catch (error) {
      console.warn('[MYNK] chat stream cancel failed:', error);
    }
  }, []);

  const reset = useCallback(() => {
    stopCurrent();
    setState(INITIAL);
  }, [stopCurrent]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopCurrent();
    };
  }, [stopCurrent]);

  return { ...state, send, cancel, reset };
};
