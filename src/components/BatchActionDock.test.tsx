import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockRust, stopRust } from '../test/ipc';
import { renderApp, resetApp } from '../test/app';
import { act, render, screen } from '@testing-library/react';
import { useAppStore } from '../store';
import BatchActionDock from './BatchActionDock';
import { ToastRegion } from './ui/ToastRegion';

const initial = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(initial, true);
});

describe('bottom overlays', () => {
  it('lifts notifications above the selection dock while it is shown', () => {
    render(
      <>
        <ToastRegion />
        <BatchActionDock />
      </>,
    );
    expect(screen.getByRole('region', { name: 'Notifications' }).className).toContain('bottom-6');

    act(() => {
      useAppStore.setState({ batchSelectedIds: ['a', 'b'] });
    });
    expect(screen.getByRole('region', { name: 'Notifications' }).className).toContain('bottom-24');
  });

  it('announces the selection once: the number badge is hidden from assistive tech', () => {
    useAppStore.setState({ batchSelectedIds: ['a', 'b'] });
    render(<BatchActionDock />);
    const toolbar = screen.getByRole('toolbar', { name: 'Selection actions' });
    const badge = toolbar.querySelector('[aria-hidden="true"]');
    expect(badge).toHaveTextContent('2');
    expect(toolbar.querySelector('.sr-only')).toHaveTextContent('2 selected');
  });
});

describe('content under the jobs HUD', () => {
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

  afterEach(() => {
    if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
    stopRust();
  });

  it('pads the scroll area by the HUD footprint so the last row can scroll clear', async () => {
    resetApp();
    mockRust();
    // jsdom has no layout; the HUD's own height stands in for its footprint.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 120,
    });
    await renderApp();
    const content = document.getElementById('main-content');
    expect(content?.style.paddingBottom).toBe('');

    act(() => {
      useAppStore.setState({
        jobs: {
          ...useAppStore.getState().jobs,
          health: {
            kind: 'health',
            state: 'running',
            total: 10,
            done: 1,
            failed: 0,
            startedAt: 0,
            finishedAt: null,
            counters: {},
          },
        },
      });
    });
    expect(content?.style.paddingBottom).toBe('120px');
    // Overflowing lists ignore the container padding, so the spacer after them must carry it.
    const spacer = () => content?.querySelector<HTMLElement>('[data-content-end]');
    expect(spacer()?.style.height).toBe('120px');

    act(() => useAppStore.setState({ viewMode: 'timeline' }));
    expect(spacer()?.style.height).toBe('120px');

    act(() => useAppStore.setState({ viewMode: 'graph' }));
    expect(content?.style.paddingBottom).toBe('');
    expect(spacer()).toBeNull();

    act(() => useAppStore.setState({ viewMode: 'grid' }));
    act(() => useAppStore.setState({ jobs: { enrich: null, health: null, preview: null } }));
    expect(content?.style.paddingBottom).toBe('');
    expect(spacer()?.className).toBe('h-6');

    act(() => useAppStore.setState({ batchSelectedIds: ['a'] }));
    expect(content?.className).toContain('pb-24');
    expect(spacer()?.className).toBe('h-24');
  });
});
