import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, renderHook } from '@testing-library/react';
import { useAppStore } from '../store';
import { pushLayer } from '../components/ui/layerStack';
import { MAX_GRAPH_NODES } from '../store/selectors';
import { makeResource } from '../test/fixtures';
import { useGlobalShortcuts } from './useGlobalShortcuts';

const initial = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(initial, true);
  document.body.innerHTML = '';
});

describe('useGlobalShortcuts', () => {
  it('leaves Escape to a focused text field', () => {
    renderHook(() => useGlobalShortcuts());
    useAppStore.setState({ selectedResourceId: 'a' });
    const field = document.createElement('textarea');
    document.body.append(field);

    fireEvent.keyDown(field, { key: 'Escape' });
    expect(useAppStore.getState().selectedResourceId).toBe('a');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useAppStore.getState().selectedResourceId).toBeNull();
  });

  it('does not open the palette over another layer but still toggles it otherwise', () => {
    renderHook(() => useGlobalShortcuts());

    const removeLayer = pushLayer(() => undefined);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(useAppStore.getState().activeModal).toBeNull();
    removeLayer();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(useAppStore.getState().activeModal).toBe('palette');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(useAppStore.getState().activeModal).toBeNull();
  });

  it('selects only what the active view shows with Ctrl+A', () => {
    renderHook(() => useGlobalShortcuts());
    const analyzed = makeResource({ summary: ['Point.'] });
    const plain = makeResource();
    useAppStore.setState({ resources: [analyzed, plain], viewMode: 'feed' });

    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    expect(useAppStore.getState().batchSelectedIds).toEqual([analyzed.id]);

    useAppStore.setState({ batchSelectedIds: [], viewMode: 'grid' });
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    expect(useAppStore.getState().batchSelectedIds).toEqual([analyzed.id, plain.id]);
  });

  it('selects only the nodes the graph draws', () => {
    renderHook(() => useGlobalShortcuts());
    const resources = Array.from({ length: MAX_GRAPH_NODES + 5 }, () => makeResource());
    useAppStore.setState({ resources, viewMode: 'graph' });

    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    const selected = useAppStore.getState().batchSelectedIds;
    expect(selected).toHaveLength(MAX_GRAPH_NODES);
    // The graph keeps the newest records; the fixtures get older one by one.
    expect(selected).toContain(resources[0]?.id);
    expect(selected).not.toContain(resources.at(-1)?.id);
  });
});
