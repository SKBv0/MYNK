import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forceSimulation } from 'd3-force';
import { useAppStore } from '../store';
import { VIEWPORT_HEIGHT, VIEWPORT_WIDTH, installDomStubs } from '../test/dom';
import { makeResource } from '../test/fixtures';
import GraphView from './GraphView';
import { nth } from '../test/assert';

vi.mock('d3-force', async (importOriginal) => {
  const actual = await importOriginal<typeof import('d3-force')>();
  return { ...actual, forceSimulation: vi.fn(actual.forceSimulation) };
});

// Every node renders exactly one SmartImage, so its render count is the node layer's.
const imageRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('./SmartImage', () => ({
  default: () => {
    imageRenders.count += 1;
    return null;
  },
}));

const initial = useAppStore.getState();

const resources = [
  makeResource({ id: 'alpha', title: 'Alpha', tags: ['rust'] }),
  makeResource({ id: 'beta', title: 'Beta', tags: ['rust'] }),
];

beforeAll(installDomStubs);

beforeEach(() => {
  useAppStore.setState(initial, true);
});

const nodeOf = (title: string) => screen.getByRole('button', { name: `${title} (Other)` });
const enterOther = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Other, 2 bookmarks' }));

describe('GraphView pointer handling', () => {
  it('selects a node that is clicked after the canvas was panned', () => {
    const onSelect = vi.fn();
    const { container } = render(<GraphView resources={resources} onSelect={onSelect} />);
    const canvas = container.firstElementChild as HTMLElement;

    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(canvas, { clientX: 140, clientY: 90 });
    fireEvent.mouseUp(canvas, { clientX: 140, clientY: 90 });
    fireEvent.click(canvas, { clientX: 140, clientY: 90 });
    expect(onSelect).not.toHaveBeenCalled();

    enterOther();
    const node = nodeOf('Alpha');
    fireEvent.mouseDown(node, { clientX: 200, clientY: 200 });
    fireEvent.mouseUp(node, { clientX: 200, clientY: 200 });
    fireEvent.click(node, { clientX: 200, clientY: 200 });
    expect(onSelect).toHaveBeenCalledWith('alpha');
  });

  it('does not select when the press on a node turns into a drag', () => {
    const onSelect = vi.fn();
    render(<GraphView resources={resources} onSelect={onSelect} />);

    enterOther();
    onSelect.mockClear();
    const node = nodeOf('Beta');
    fireEvent.mouseDown(node, { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(node, { clientX: 320, clientY: 260 });
    fireEvent.mouseUp(node, { clientX: 320, clientY: 260 });
    fireEvent.click(node, { clientX: 320, clientY: 260 });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('GraphView layout', () => {
  it('keeps the simulation when only record content changes', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<GraphView resources={resources} onSelect={onSelect} />);
    enterOther();
    const built = vi.mocked(forceSimulation).mock.calls.length;
    const before = nodeOf('Beta').getAttribute('transform');

    const renamed = [{ ...nth(resources, 0), title: 'Alpha renamed' }, nth(resources, 1)];
    rerender(<GraphView resources={renamed} onSelect={onSelect} />);

    expect(vi.mocked(forceSimulation).mock.calls.length).toBe(built);
    expect(nodeOf('Alpha renamed')).toBeInTheDocument();
    expect(nodeOf('Beta').getAttribute('transform')).toBe(before);

    rerender(
      <GraphView
        resources={[...renamed, makeResource({ id: 'gamma', title: 'Gamma' })]}
        onSelect={onSelect}
      />,
    );
    expect(vi.mocked(forceSimulation).mock.calls.length).toBe(built + 1);
  });

  it('pans and zooms without re-rendering the nodes', async () => {
    const { container } = render(<GraphView resources={resources} onSelect={vi.fn()} />);
    enterOther();
    const canvas = container.firstElementChild as HTMLElement;
    const viewport = container.querySelector('[data-graph-viewport]') as SVGGElement;
    expect(nodeOf('Alpha')).toBeInTheDocument();
    await waitFor(() =>
      expect(viewport.getAttribute('transform')).not.toBe('translate(0, 0) scale(1)'),
    );
    const numbers = (text: string | null) => (text?.match(/-?[\d.]+(e-?\d+)?/g) ?? []).map(Number);
    const [beforeX = 0, beforeY = 0] = numbers(viewport.getAttribute('transform'));
    const rendersAfterMount = imageRenders.count;

    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 40 });
    fireEvent.mouseMove(canvas, { clientX: 110, clientY: 70 });
    fireEvent.mouseUp(canvas, { clientX: 110, clientY: 70 });
    await waitFor(() => {
      const [afterX = 0, afterY = 0] = numbers(viewport.getAttribute('transform'));
      expect(afterX - beforeX).toBeCloseTo(100, 0);
      expect(afterY - beforeY).toBeCloseTo(60, 0);
    });

    fireEvent.wheel(canvas, { deltaY: 100, clientX: 0, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(viewport.getAttribute('transform')).toMatch(/scale\(1\.06/));
    expect(screen.getByText('106%')).toBeInTheDocument();

    expect(imageRenders.count).toBe(rendersAfterMount);
    expect(nodeOf('Alpha').getAttribute('transform')).toMatch(/^translate\([\d.-]+,[\d.-]+\)$/);
  });

  it('announces the zoom level once after the buttons, not on every change', async () => {
    render(<GraphView resources={resources} onSelect={vi.fn()} />);
    enterOther();
    const status = screen.getByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(status).toHaveTextContent('');
    await waitFor(() => expect(status).toHaveTextContent('Zoom 156%'));
    expect(document.querySelector('[aria-live]')).toBeNull();
  });

  it('caps and fits a large category into the view on "Reset view"', async () => {
    const many = Array.from({ length: 58 }, (_, i) =>
      makeResource({ id: `n${i}`, title: `Node ${i}`, categoryId: 'development' }),
    );
    const { container } = render(<GraphView resources={many} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Development, 58 bookmarks' }));
    const viewport = container.querySelector('[data-graph-viewport]') as SVGGElement;
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    await waitFor(() =>
      expect(viewport.getAttribute('transform')).not.toBe('translate(0, 0) scale(1)'),
    );

    const numbers = (text: string | null) => (text?.match(/-?[\d.]+(e-?\d+)?/g) ?? []).map(Number);
    const [tx = 0, ty = 0, scale = 1] = numbers(viewport.getAttribute('transform'));
    const nodes = container.querySelectorAll('g[role="button"]');
    expect(nodes).toHaveLength(40);
    for (const node of nodes) {
      const [x = NaN, y = NaN] = numbers(node.getAttribute('transform'));
      expect(x * scale + tx).toBeGreaterThan(0);
      expect(x * scale + tx).toBeLessThan(VIEWPORT_WIDTH);
      expect(y * scale + ty).toBeGreaterThan(0);
      expect(y * scale + ty).toBeLessThan(VIEWPORT_HEIGHT);
    }
  });

  it('starts with category clusters and drills into a selected bookmark neighbourhood', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<GraphView resources={resources} onSelect={onSelect} />);

    expect(screen.getByText('Choose a category to explore its bookmarks')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Alpha (Other)' })).not.toBeInTheDocument();
    enterOther();
    expect(nodeOf('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 2 bookmarks')).toBeInTheDocument();

    rerender(<GraphView resources={resources} onSelect={onSelect} selectedResourceId="alpha" />);
    expect(screen.getByText('1 closest connection')).toBeInTheDocument();
    expect(nodeOf('Alpha')).toBeInTheDocument();
    expect(nodeOf('Beta')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All bookmarks' }));
    expect(screen.getByText('Choose a category to explore its bookmarks')).toBeInTheDocument();
  });
});
