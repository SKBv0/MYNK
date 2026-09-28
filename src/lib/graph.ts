import type { CategoryId, Resource } from '../types';
import { CATEGORY_IDS } from './categories';

/** Neighbors kept per resource; an edge survives when either end ranks it this high. */
const NEIGHBOURS_PER_NODE = 4;
/** Tags on more resources than this are too common to enumerate every pair. */
const DENSE_TAG_LIMIT = 48;
/** Members of a dense tag are paired with this many list neighbors instead. */
const DENSE_TAG_NEIGHBOURS = 2;

export interface TagEdge {
  source: string;
  target: string;
  /** 0..1, relative to the strongest edge in the graph. */
  strength: number;
}

const tagWeight = (total: number, members: number) => Math.log(1 + total / members);

/**
 * Edges between resources sharing tags, weighted so a rare tag binds tighter (`log(1 + N/df)`),
 * thinned to strongest neighbors; a very common tag pairs list neighbors only, to stay linear.
 */
export const buildTagEdges = (resources: Resource[]): { links: TagEdge[] } => {
  const byTag = new Map<string, string[]>();
  for (const resource of resources) {
    for (const tag of resource.tags) {
      const list = byTag.get(tag);
      if (list) list.push(resource.id);
      else byTag.set(tag, [resource.id]);
    }
  }

  const weights = new Map<string, { source: string; target: string; weight: number }>();
  const addEdge = (a: string | undefined, b: string | undefined, weight: number) => {
    if (a === undefined || b === undefined || a === b) return;
    const [source, target] = a < b ? [a, b] : [b, a];
    const key = `${source}|${target}`;
    const edge = weights.get(key);
    if (edge) edge.weight += weight;
    else weights.set(key, { source, target, weight });
  };

  const total = resources.length;
  for (const members of byTag.values()) {
    if (members.length < 2) continue;
    const weight = tagWeight(total, members.length);
    if (members.length <= DENSE_TAG_LIMIT) {
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) addEdge(members[i], members[j], weight);
      }
    } else {
      for (let i = 0; i < members.length; i += 1) {
        for (let k = 1; k <= DENSE_TAG_NEIGHBOURS; k += 1) {
          addEdge(members[i], members[(i + k) % members.length], weight);
        }
      }
    }
  }

  const byNode = new Map<string, { source: string; target: string; weight: number }[]>();
  for (const edge of weights.values()) {
    for (const id of [edge.source, edge.target]) {
      const list = byNode.get(id);
      if (list) list.push(edge);
      else byNode.set(id, [edge]);
    }
  }
  const kept = new Set<{ source: string; target: string; weight: number }>();
  for (const list of byNode.values()) {
    list.sort((a, b) => b.weight - a.weight);
    for (const edge of list.slice(0, NEIGHBOURS_PER_NODE)) kept.add(edge);
  }

  let max = 0;
  for (const edge of kept) max = Math.max(max, edge.weight);
  const links = [...kept].map(({ source, target, weight }) => ({
    source,
    target,
    strength: max > 0 ? weight / max : 0,
  }));
  return { links };
};

export interface Point {
  x: number;
  y: number;
}

/**
 * Cluster centers for the categories present: one category sits in the middle, several share a
 * ring (side by side when there are two) and "other" takes the middle.
 */
export const categoryCenters = (
  width: number,
  height: number,
  present: readonly CategoryId[],
): Record<CategoryId, Point> => {
  const middle = { x: width / 2, y: height / 2 };
  const centers = Object.fromEntries(CATEGORY_IDS.map((id) => [id, middle])) as Record<
    CategoryId,
    Point
  >;
  const ring = present.filter((id) => id !== 'other');
  if (ring.length === 0 || (ring.length === 1 && !present.includes('other'))) return centers;
  const radius = Math.min(width, height) * 0.36;
  const start = ring.length <= 2 ? Math.PI : -Math.PI / 2;
  ring.forEach((id, index) => {
    const angle = start + (index / ring.length) * Math.PI * 2;
    centers[id] = {
      x: middle.x + Math.cos(angle) * radius,
      y: middle.y + Math.sin(angle) * radius,
    };
  });
  return centers;
};

/**
 * Pan and zoom that fit every point, padded by `margin` on each side, into the view; never
 * zooms in past 1 and not below `minScale`.
 */
export const fitTransform = (
  points: readonly Point[],
  width: number,
  height: number,
  margin: number,
  minScale: number,
): { x: number; y: number; scale: number } => {
  if (points.length === 0) return { x: 0, y: 0, scale: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const contentWidth = maxX - minX + margin * 2;
  const contentHeight = maxY - minY + margin * 2;
  const scale = Math.max(minScale, Math.min(1, width / contentWidth, height / contentHeight));
  return {
    x: width / 2 - ((minX + maxX) / 2) * scale,
    y: height / 2 - ((minY + maxY) / 2) * scale,
    scale,
  };
};
