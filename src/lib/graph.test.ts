import { describe, expect, it } from 'vitest';
import { buildTagEdges, categoryCenters, fitTransform } from './graph';
import { makeResource } from '../test/fixtures';

const withTags = (id: string, tags: string[]) =>
  makeResource({ id, url: `https://${id}.example.com/`, tags });

const edge = (
  links: { source: string; target: string; strength: number }[],
  a: string,
  b: string,
) => links.find((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a));

describe('buildTagEdges', () => {
  it('binds a rare shared tag tighter than a common one', () => {
    const resources = [
      withTags('a', ['social', 'rust']),
      withTags('b', ['social', 'rust']),
      withTags('c', ['social']),
      ...Array.from({ length: 12 }, (_, i) => withTags(`s${i}`, ['social'])),
    ];
    const { links } = buildTagEdges(resources);
    const rare = edge(links, 'a', 'b');
    const common = edge(links, 'a', 'c');
    expect(rare?.strength).toBe(1);
    expect(common).toBeDefined();
    expect(common?.strength ?? 0).toBeLessThan(rare?.strength ?? 0);
  });

  it("keeps only each resource's strongest neighbors", () => {
    // "hub" shares a distinct rare tag with ten others; only the strongest few survive.
    const others = Array.from({ length: 10 }, (_, i) => withTags(`o${i}`, [`t${i}`, 'common']));
    const hub = withTags(
      'hub',
      others.map((_, i) => `t${i}`),
    );
    const { links } = buildTagEdges([hub, ...others]);
    const hubEdges = links.filter((l) => l.source === 'hub' || l.target === 'hub');
    expect(hubEdges.length).toBeLessThanOrEqual(10);
    expect(hubEdges.length).toBeGreaterThan(0);
    // Every other resource still reaches the hub through its own top list.
    for (const other of others) {
      expect(edge(links, 'hub', other.id)).toBeDefined();
    }
  });

  it('stays linear for a tag shared by hundreds of resources', () => {
    const many = Array.from({ length: 400 }, (_, i) => withTags(`m${i}`, ['news']));
    const { links } = buildTagEdges(many);
    expect(links.length).toBeLessThan(400 * 3);
    expect(links.every((l) => l.strength > 0 && l.strength <= 1)).toBe(true);
  });

  it('never links a resource to itself or without a shared tag', () => {
    const { links } = buildTagEdges([withTags('a', ['x']), withTags('b', ['y'])]);
    expect(links).toEqual([]);
  });
});

describe('categoryCenters', () => {
  it('puts a lone category in the middle of the view', () => {
    const centers = categoryCenters(1200, 700, ['development']);
    expect(centers.development).toEqual({ x: 600, y: 350 });
  });

  it('places two categories side by side and keeps "other" in the middle', () => {
    const two = categoryCenters(1200, 700, ['design', 'development']);
    expect(two.design.y).toBeCloseTo(350);
    expect(two.development.y).toBeCloseTo(350);
    expect(two.design.x).not.toBeCloseTo(two.development.x);

    const withOther = categoryCenters(1200, 700, ['news', 'other']);
    expect(withOther.other).toEqual({ x: 600, y: 350 });
    expect(withOther.news.y).toBeCloseTo(350);
    expect(withOther.news.x).toBeLessThan(600);
  });

  it('spreads many categories over a ring inside the view', () => {
    const present = ['development', 'design', 'research', 'news', 'tools'] as const;
    const centers = categoryCenters(1200, 700, present);
    const spots = new Set(
      present.map((id) => `${centers[id].x.toFixed(1)},${centers[id].y.toFixed(1)}`),
    );
    expect(spots.size).toBe(present.length);
    for (const id of present) {
      expect(centers[id].y).toBeGreaterThan(0);
      expect(centers[id].y).toBeLessThan(700);
    }
  });
});

describe('fitTransform', () => {
  it('shrinks and centers content larger than the view', () => {
    const points = [
      { x: 100, y: -400 },
      { x: 700, y: 500 },
    ];
    const fit = fitTransform(points, 1200, 700, 50, 0.2);
    expect(fit.scale).toBeLessThan(1);
    for (const { x, y } of points) {
      const sx = x * fit.scale + fit.x;
      const sy = y * fit.scale + fit.y;
      expect(sx).toBeGreaterThanOrEqual(50 * fit.scale - 1e-9);
      expect(sx).toBeLessThanOrEqual(1200 - 50 * fit.scale + 1e-9);
      expect(sy).toBeGreaterThanOrEqual(50 * fit.scale - 1e-9);
      expect(sy).toBeLessThanOrEqual(700 - 50 * fit.scale + 1e-9);
    }
  });

  it('centers small content without zooming in, and resets an empty graph', () => {
    expect(fitTransform([{ x: 10, y: 20 }], 1200, 700, 50, 0.2)).toEqual({
      x: 590,
      y: 330,
      scale: 1,
    });
    expect(fitTransform([], 1200, 700, 50, 0.2)).toEqual({ x: 0, y: 0, scale: 1 });
  });
});
