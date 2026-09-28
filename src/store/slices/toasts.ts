import type { StateCreator } from 'zustand';
import type { Toast, ToastType } from '../../types';
import type { AppState } from '../state';
import { newId } from '../../lib/id';

export const MAX_TOASTS = 4;
const DEFAULT_DURATION_MS = 4500;
const ERROR_DURATION_MS = 7000;
/** A toast with a button stays long enough to read it and reach for the button. */
export const ACTION_DURATION_MS = 10_000;

export interface ToastOptions {
  action?: Toast['action'];
  /** 0 keeps the toast until dismissed. */
  durationMs?: number;
}

export interface ToastsSlice {
  toasts: Toast[];
  pushToast: (message: string, type?: ToastType, options?: ToastOptions) => string;
  dismissToast: (id: string) => void;
  /** Holds the dismiss timer while the pointer is over a toast or focus is inside it. */
  holdToast: (id: string, held: boolean) => void;
}

/** Auto-dismiss timers live outside the state so they can always be cleared. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** How long each toast was meant to stay, so a held one can be rescheduled on release. */
const durations = new Map<string, number>();
const held = new Set<string>();

const clearTimer = (id: string) => {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
};

const forgetTimer = (id: string) => {
  clearTimer(id);
  durations.delete(id);
  held.delete(id);
};

export const createToastsSlice: StateCreator<AppState, [], [], ToastsSlice> = (set, get) => {
  const arm = (id: string, duration: number) => {
    clearTimer(id);
    if (duration <= 0 || held.has(id)) return;
    timers.set(
      id,
      setTimeout(() => get().dismissToast(id), duration),
    );
  };

  const schedule = (id: string, type: ToastType, options?: ToastOptions) => {
    const duration =
      options?.durationMs ??
      (options?.action
        ? ACTION_DURATION_MS
        : type === 'error'
          ? ERROR_DURATION_MS
          : DEFAULT_DURATION_MS);
    durations.set(id, duration);
    arm(id, duration);
  };

  return {
    toasts: [],

    pushToast: (message, type = 'info', options) => {
      const existing = get().toasts.find((t) => t.message === message && t.type === type);
      if (existing) {
        // A refresh owns the action too: an old "Show" would open the wrong record.
        const action = options?.action;
        if (action !== existing.action) {
          set((state) => ({
            toasts: state.toasts.map((t) => {
              if (t.id !== existing.id) return t;
              const next: Toast = { ...t };
              if (action) next.action = action;
              else delete next.action;
              return next;
            }),
          }));
        }
        schedule(existing.id, type, options);
        return existing.id;
      }

      const toast: Toast = { id: newId(), message, type };
      if (options?.action) toast.action = options.action;
      const next = [...get().toasts, toast];
      while (next.length > MAX_TOASTS) {
        // Only auto-dismissing toasts are evicted.
        const auto = next.findIndex(
          (t, index) => index < next.length - 1 && (durations.get(t.id) ?? 0) > 0,
        );
        if (auto < 0) break;
        const [dropped] = next.splice(auto, 1);
        if (dropped) forgetTimer(dropped.id);
      }
      set({ toasts: next });
      schedule(toast.id, type, options);
      return toast.id;
    },

    dismissToast: (id) => {
      forgetTimer(id);
      set((state) =>
        state.toasts.some((t) => t.id === id)
          ? { toasts: state.toasts.filter((t) => t.id !== id) }
          : state,
      );
    },

    holdToast: (id, hold) => {
      if (hold) {
        held.add(id);
        clearTimer(id);
        return;
      }
      held.delete(id);
      arm(id, durations.get(id) ?? 0);
    },
  };
};
