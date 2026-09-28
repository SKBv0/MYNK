import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../index';
import { ACTION_DURATION_MS } from './toasts';

const PRISTINE = useAppStore.getState();
const messages = () => useAppStore.getState().toasts.map((toast) => toast.message);

beforeEach(() => {
  useAppStore.setState(PRISTINE, true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toast durations', () => {
  it('keeps a toast with an action long enough to use it', () => {
    expect(ACTION_DURATION_MS).toBeGreaterThanOrEqual(8000);
    const action = { label: 'Show', run: () => undefined };
    useAppStore.getState().pushToast('Link added', 'success', { action });
    useAppStore.getState().pushToast('Plain note', 'success');

    vi.advanceTimersByTime(6000);
    expect(messages()).toEqual(['Link added']);

    vi.advanceTimersByTime(ACTION_DURATION_MS - 6000);
    expect(messages()).toEqual([]);
  });

  it('lets an explicit duration win over the action default', () => {
    const action = { label: 'Install', run: () => undefined };
    useAppStore.getState().pushToast('Update ready', 'info', { action, durationMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(messages()).toEqual(['Update ready']);
  });
});
