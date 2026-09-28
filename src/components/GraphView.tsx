import React, {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BookOpen,
  Briefcase,
  ChevronRight,
  Clapperboard,
  Cpu,
  Globe,
  GraduationCap,
  HeartPulse,
  Info,
  Maximize2,
  Minus,
  Newspaper,
  Palette,
  Plane,
  Plus,
  Search,
  ShoppingBag,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { CategoryId, Resource } from '../types';
import SmartImage from './SmartImage';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { CATEGORY_IDS } from '../lib/categories';
import { resourcePreviews } from '../lib/media';
import { graphResources } from '../store/selectors';
import { fmt } from '../lib/text';
import { buildTagEdges, categoryCenters, fitTransform } from '../lib/graph';
import { INSET_SURFACE, IconButton, cx } from './ui';

interface GraphViewProps {
  resources: Resource[];
  onSelect: (id: string | null) => void;
  selectedResourceId?: string | null;
}

interface ForceNode extends SimulationNodeDatum {
  id: string;
  resource: Resource;
}

interface ForceLink extends SimulationLinkDatum<ForceNode> {
  id: string;
  strength: number;
}

const DRAG_THRESHOLD_PX = 4;
/** Labels for every node while the graph is small or zoomed in. */
const ALWAYS_LABEL_NODES = 24;
const LABEL_ZOOM = 1.5;
const LABEL_MAX = 28;
const NODE_SIZE = 44;
/** Room kept around the outermost nodes when the view is fitted: node radius plus its label. */
const FIT_MARGIN = NODE_SIZE + 24;
/** Zoom buttons announce the new level once the user stops clicking. */
const ZOOM_ANNOUNCE_DELAY_MS = 500;
const CATEGORY_NODE_LIMIT = 40;
const NEIGHBOURHOOD_NODE_LIMIT = 20;
const CLUSTER_MIN_RADIUS = 34;
const CLUSTER_MAX_RADIUS = 58;

/** Category color (design tokens `--viz-*`, `other` = accent) and icon. */
const CATEGORY_STYLE: Record<CategoryId, { color: string; icon: React.ElementType }> = {
  development: { color: 'var(--viz-1)', icon: Cpu },
  design: { color: 'var(--viz-2)', icon: Palette },
  research: { color: 'var(--viz-3)', icon: Search },
  business: { color: 'var(--viz-7)', icon: Briefcase },
  news: { color: 'var(--viz-6)', icon: Newspaper },
  learning: { color: 'var(--viz-8)', icon: GraduationCap },
  tools: { color: 'var(--viz-4)', icon: Wrench },
  entertainment: { color: 'var(--viz-5)', icon: Clapperboard },
  finance: { color: 'var(--viz-3)', icon: Wallet },
  health: { color: 'var(--viz-6)', icon: HeartPulse },
  shopping: { color: 'var(--viz-2)', icon: ShoppingBag },
  travel: { color: 'var(--viz-4)', icon: Plane },
  reference: { color: 'var(--viz-7)', icon: BookOpen },
  social: { color: 'var(--viz-5)', icon: Users },
  other: { color: 'var(--accent)', icon: Globe },
};

const hash = (value: string): number => {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return h;
};

/** Deterministic jitter in [-range, range] (no Math.random). */
const jitter = (id: string, salt: string, range: number) =>
  ((Math.abs(hash(`${id}:${salt}`)) % 1000) / 1000 - 0.5) * 2 * range;

const endpointId = (end: string | number | ForceNode | undefined): string =>
  typeof end === 'object' && end !== null ? end.id : String(end);

const hasPosition = (node: ForceNode | string | number | undefined): node is ForceNode =>
  typeof node === 'object' &&
  node !== null &&
  typeof node.x === 'number' &&
  typeof node.y === 'number';

const shorten = (text: string) =>
  text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;

interface Transform {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
const clampScale = (scale: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
const transformAttr = ({ x, y, scale }: Transform) => `translate(${x}, ${y}) scale(${scale})`;

/** Writes simulation positions straight to the DOM; React only renders structure and state. */
const writePositions = (
  nodes: readonly ForceNode[],
  links: readonly ForceLink[],
  nodeEls: ReadonlyMap<string, SVGGElement>,
  linkEls: ReadonlyMap<string, SVGLineElement>,
) => {
  for (const node of nodes) {
    if (!hasPosition(node)) continue;
    nodeEls.get(node.id)?.setAttribute('transform', `translate(${node.x},${node.y})`);
  }
  for (const link of links) {
    const el = linkEls.get(link.id);
    if (!el) continue;
    const { source, target } = link;
    if (!hasPosition(source) || !hasPosition(target)) {
      el.setAttribute('visibility', 'hidden');
      continue;
    }
    el.removeAttribute('visibility');
    el.setAttribute('x1', String(source.x));
    el.setAttribute('y1', String(source.y));
    el.setAttribute('x2', String(target.x));
    el.setAttribute('y2', String(target.y));
  }
};

/** Stable callbacks shared by every node, so a memoized node only re-renders for its own state. */
interface NodeHandlers {
  register: (id: string, el: SVGGElement | null) => void;
  hover: (id: string | null) => void;
  focus: (id: string) => void;
  blur: () => void;
  press: (e: React.MouseEvent) => void;
  activate: (id: string, viaPointer: boolean) => void;
}

interface GraphNodeProps {
  id: string;
  resource: Resource;
  ariaLabel: string;
  mediaReady: boolean;
  isSelected: boolean;
  isActive: boolean;
  isFocused: boolean;
  isDimmed: boolean;
  showLabel: boolean;
  handlers: NodeHandlers;
}

const GraphNode = memo(function GraphNode({
  id,
  resource,
  ariaLabel,
  mediaReady,
  isSelected,
  isActive,
  isFocused,
  isDimmed,
  showLabel,
  handlers,
}: GraphNodeProps) {
  const radius = (isSelected ? NODE_SIZE * 1.3 : isActive ? NODE_SIZE * 1.15 : NODE_SIZE) / 2;
  const style = CATEGORY_STYLE[resource.categoryId] ?? CATEGORY_STYLE.other;
  const Icon = style.icon;
  const ref = useCallback((el: SVGGElement | null) => handlers.register(id, el), [handlers, id]);

  return (
    <g
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-pressed={isSelected}
      data-own-focus-ring=""
      className={cx(
        'cursor-pointer transition-opacity duration-base',
        isDimmed ? 'opacity-30' : 'opacity-100',
      )}
      onMouseEnter={() => handlers.hover(id)}
      onMouseLeave={() => handlers.hover(null)}
      onFocus={() => handlers.focus(id)}
      onBlur={handlers.blur}
      onMouseDown={(e) => {
        e.stopPropagation();
        handlers.press(e);
      }}
      onClick={(e) => {
        e.stopPropagation();
        handlers.activate(id, true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handlers.activate(id, false);
        }
      }}
    >
      {isFocused && (
        <circle r={radius + 6} fill="none" stroke="var(--accent-text)" strokeWidth={2} />
      )}
      <circle
        r={radius}
        fill="var(--surface-2)"
        stroke={isSelected ? 'var(--accent)' : style.color}
        strokeWidth={isSelected ? 3 : 2}
      />
      <foreignObject
        x={-radius + 3}
        y={-radius + 3}
        width={radius * 2 - 6}
        height={radius * 2 - 6}
        className="pointer-events-none"
      >
        <div className="h-full w-full overflow-hidden rounded-full">
          <SmartImage
            sources={resourcePreviews(resource, mediaReady)}
            className="h-full w-full object-cover"
            alt=""
            loading="lazy"
            fallback={
              <div
                className="flex h-full w-full items-center justify-center bg-surface-3"
                // The category color is data-driven (CATEGORY_STYLE); the surface is a token.
                style={{ color: style.color }}
              >
                <Icon size={16} aria-hidden />
              </div>
            }
          />
        </div>
      </foreignObject>
      {showLabel && (
        <text
          y={radius + 16}
          textAnchor="middle"
          className="pointer-events-none"
          fill={isActive || isSelected ? 'var(--text-primary)' : 'var(--text-secondary)'}
          stroke="var(--surface-1)"
          strokeWidth={4}
          paintOrder="stroke"
          fontSize={12}
          fontWeight={isActive || isSelected ? 600 : 500}
          aria-hidden
        >
          {shorten(resource.title)}
        </text>
      )}
    </g>
  );
});

interface GraphEdgeProps {
  id: string;
  strength: number;
  isHighlighted: boolean;
  register: (id: string, el: SVGLineElement | null) => void;
}

interface ClusterEdge {
  id: string;
  source: CategoryId;
  target: CategoryId;
  strength: number;
}

const buildClusterEdges = (resources: readonly Resource[]): ClusterEdge[] => {
  const categoryById = new Map(resources.map((resource) => [resource.id, resource.categoryId]));
  const totals = new Map<string, ClusterEdge>();
  for (const edge of buildTagEdges([...resources]).links) {
    const source = categoryById.get(edge.source);
    const target = categoryById.get(edge.target);
    if (!source || !target || source === target) continue;
    const [a, b] = source < target ? [source, target] : [target, source];
    const id = `${a}-${b}`;
    const current = totals.get(id);
    if (current) current.strength += edge.strength;
    else totals.set(id, { id, source: a, target: b, strength: edge.strength });
  }

  const ranked = new Map<CategoryId, ClusterEdge[]>();
  for (const edge of totals.values()) {
    for (const category of [edge.source, edge.target]) {
      const list = ranked.get(category);
      if (list) list.push(edge);
      else ranked.set(category, [edge]);
    }
  }
  const kept = new Set<ClusterEdge>();
  for (const list of ranked.values()) {
    list.sort((a, b) => b.strength - a.strength);
    for (const edge of list.slice(0, 2)) kept.add(edge);
  }
  const max = Math.max(0, ...[...kept].map((edge) => edge.strength));
  return [...kept].map((edge) => ({
    ...edge,
    strength: max > 0 ? edge.strength / max : 0,
  }));
};

const GraphEdge = memo(function GraphEdge({
  id,
  strength,
  isHighlighted,
  register,
}: GraphEdgeProps) {
  const ref = useCallback((el: SVGLineElement | null) => register(id, el), [register, id]);
  return (
    <line
      ref={ref}
      stroke={isHighlighted ? 'var(--accent)' : 'var(--border-strong)'}
      strokeWidth={isHighlighted ? 1.5 + strength : Math.max(strength, 0.6)}
    />
  );
});

/** Tag graph. Pan/zoom and simulation ticks write positions to the DOM, bypassing React state. */
const GraphView: React.FC<GraphViewProps> = ({ resources, onSelect, selectedResourceId }) => {
  const { t } = useTranslation();
  const mediaReady = useAppStore((s) => s.mediaReady);
  const hintId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const [size, setSize] = useState({ width: 1200, height: 700 });
  const transformRef = useRef<Transform>({ x: 0, y: 0, scale: 1 });
  const transformRafRef = useRef(0);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [zoomedIn, setZoomedIn] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<CategoryId | null>(null);
  const [graph, setGraph] = useState<{ nodes: ForceNode[]; links: ForceLink[] }>({
    nodes: [],
    links: [],
  });
  const dragRef = useRef({
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    moved: 0,
    pressed: false,
  });
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const nodeElsRef = useRef(new Map<string, SVGGElement>());
  const linkElsRef = useRef(new Map<string, SVGLineElement>());
  const nodesRef = useRef<ForceNode[]>([]);
  const sizeRef = useRef(size);
  const viewSizeRef = useRef(size);
  const onSelectRef = useRef(onSelect);
  const [zoomAnnouncement, setZoomAnnouncement] = useState('');
  const announceZoomRef = useRef(false);

  useLayoutEffect(() => {
    onSelectRef.current = onSelect;
    viewSizeRef.current = size;
  }, [onSelect, size]);

  const graphPool = useMemo(() => graphResources(resources), [resources]);
  const categoryResources = useMemo(
    () =>
      activeCategory === null
        ? []
        : graphPool.filter((resource) => resource.categoryId === activeCategory),
    [activeCategory, graphPool],
  );
  const categoryEdges = useMemo(() => buildTagEdges(categoryResources), [categoryResources]);
  const categoryAdjacency = useMemo(() => {
    const map = new Map<string, { id: string; strength: number }[]>();
    for (const edge of categoryEdges.links) {
      const source = map.get(edge.source) ?? [];
      source.push({ id: edge.target, strength: edge.strength });
      map.set(edge.source, source);
      const target = map.get(edge.target) ?? [];
      target.push({ id: edge.source, strength: edge.strength });
      map.set(edge.target, target);
    }
    return map;
  }, [categoryEdges]);
  const shown = useMemo(() => {
    if (activeCategory === null) return [];
    const selected = selectedResourceId
      ? categoryResources.find((resource) => resource.id === selectedResourceId)
      : undefined;
    if (!selected) return categoryResources.slice(0, CATEGORY_NODE_LIMIT);
    const neighbours = [...(categoryAdjacency.get(selected.id) ?? [])]
      .sort((a, b) => b.strength - a.strength)
      .slice(0, NEIGHBOURHOOD_NODE_LIMIT - 1);
    const byId = new Map(categoryResources.map((resource) => [resource.id, resource]));
    return [selected, ...neighbours.map(({ id }) => byId.get(id)).filter(Boolean)] as Resource[];
  }, [activeCategory, categoryAdjacency, categoryResources, selectedResourceId]);
  const edges = useMemo(() => buildTagEdges(shown), [shown]);
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const { source, target } of edges.links) {
      if (!map.has(source)) map.set(source, new Set());
      if (!map.has(target)) map.set(target, new Set());
      map.get(source)?.add(target);
      map.get(target)?.add(source);
    }
    return map;
  }, [edges]);
  // What the simulation depends on; a rewritten title/summary alone must not rebuild the layout.
  const nodeSignature = useMemo(
    () => shown.map((r) => `${r.id}:${r.categoryId}`).join('|'),
    [shown],
  );
  const edgeSignature = useMemo(
    () => edges.links.map((l) => `${l.source}>${l.target}:${l.strength}`).join('|'),
    [edges],
  );
  const resourceById = useMemo(() => new Map(shown.map((r) => [r.id, r])), [shown]);
  const latestRef = useRef({ shown, edges });
  // The cluster a keyboard user opened is removed, so focus moves to its first bookmark.
  const focusFirstNodeRef = useRef(false);
  useEffect(() => {
    if (!focusFirstNodeRef.current || activeCategory === null) return;
    focusFirstNodeRef.current = false;
    nodeElsRef.current.values().next().value?.focus();
  }, [activeCategory, shown]);
  useLayoutEffect(() => {
    latestRef.current = { shown, edges };
    for (const node of nodesRef.current) {
      const next = resourceById.get(node.id);
      if (next) node.resource = next;
    }
  }, [shown, edges, resourceById]);
  const presentCategories = useMemo(() => {
    const set = new Set<CategoryId>();
    for (const r of graphPool) set.add(r.categoryId);
    return CATEGORY_IDS.filter((id) => set.has(id));
  }, [graphPool]);
  const categoryCounts = useMemo(() => {
    const counts = new Map<CategoryId, number>();
    for (const resource of graphPool) {
      counts.set(resource.categoryId, (counts.get(resource.categoryId) ?? 0) + 1);
    }
    return counts;
  }, [graphPool]);
  const clusterEdges = useMemo(() => buildClusterEdges(graphPool), [graphPool]);
  const clusterCenters = useMemo(
    () => categoryCenters(size.width, size.height, presentCategories),
    [presentCategories, size.height, size.width],
  );
  const maxCategoryCount = Math.max(1, ...categoryCounts.values());

  useEffect(() => {
    if (!selectedResourceId) return;
    const selected = graphPool.find((resource) => resource.id === selectedResourceId);
    if (selected) {
      setActiveCategory((current) =>
        current === selected.categoryId ? current : selected.categoryId,
      );
    }
  }, [graphPool, selectedResourceId]);

  useEffect(() => {
    if (
      activeCategory !== null &&
      !graphPool.some((resource) => resource.categoryId === activeCategory)
    ) {
      setActiveCategory(null);
      onSelectRef.current(null);
    }
  }, [activeCategory, graphPool]);

  // Single point of change for the view transform: ref updates at once, DOM once per frame.
  const setTransform = useCallback((update: (prev: Transform) => Transform) => {
    const prev = transformRef.current;
    const next = update(prev);
    if (next === prev) return;
    transformRef.current = next;
    if (!transformRafRef.current) {
      transformRafRef.current = window.requestAnimationFrame(() => {
        transformRafRef.current = 0;
        viewportRef.current?.setAttribute('transform', transformAttr(transformRef.current));
      });
    }
    setZoomPercent(Math.round(next.scale * 100));
    setZoomedIn(next.scale >= LABEL_ZOOM);
  }, []);

  useLayoutEffect(() => {
    viewportRef.current?.setAttribute('transform', transformAttr(transformRef.current));
    return () => {
      if (transformRafRef.current) window.cancelAnimationFrame(transformRafRef.current);
      transformRafRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const width = Math.max(320, el.clientWidth);
      const height = Math.max(320, el.clientHeight);
      setSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Wheel zoom around the cursor; native listener so preventDefault works (passive: false).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      setTransform((prev) => {
        const scale = clampScale(prev.scale * (1 - event.deltaY * 0.0015));
        const ratio = scale / prev.scale;
        return { scale, x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setTransform]);

  // Force simulation: positions live in refs and go to the DOM at most once per frame.
  useEffect(() => {
    if (activeCategory === null) {
      nodesRef.current = [];
      positionsRef.current.clear();
      setGraph({ nodes: [], links: [] });
      setTransform(() => ({ x: 0, y: 0, scale: 1 }));
      return undefined;
    }
    const { shown, edges } = latestRef.current;
    const present = CATEGORY_IDS.filter((id) => shown.some((r) => r.categoryId === id));
    const centers = categoryCenters(size.width, size.height, present);
    if (activeCategory !== null) {
      centers[activeCategory] = {
        x: size.width / 2 + Math.min(110, size.width * 0.1),
        y: size.height / 2 + 24,
      };
    }
    const resized = sizeRef.current.width !== size.width || sizeRef.current.height !== size.height;
    sizeRef.current = size;
    const positions = positionsRef.current;
    // Drop remembered positions of resources that left the view.
    const live = new Set(shown.map((resource) => resource.id));
    for (const id of positions.keys()) if (!live.has(id)) positions.delete(id);
    let reused = 0;
    const nodes: ForceNode[] = shown.map((resource) => {
      const previous = positions.get(resource.id);
      if (previous) reused += 1;
      const center = centers[resource.categoryId] ?? centers.other;
      return {
        id: resource.id,
        resource,
        x: previous?.x ?? center.x + jitter(resource.id, 'x', 60),
        y: previous?.y ?? center.y + jitter(resource.id, 'y', 60),
      };
    });
    const links: ForceLink[] = edges.links.map((link) => ({
      ...link,
      id: `${link.source}-${link.target}`,
    }));
    nodesRef.current = nodes;

    const allReused = nodes.length > 0 && reused === nodes.length;
    const simulation = forceSimulation<ForceNode>(nodes)
      .force('charge', forceManyBody<ForceNode>().strength(-160).distanceMax(420))
      .force('collide', forceCollide<ForceNode>(40).iterations(2))
      .force(
        'link',
        forceLink<ForceNode, ForceLink>(links)
          .id((d) => d.id)
          .distance(140)
          .strength((l) => l.strength * 0.4),
      )
      .force(
        'x',
        forceX<ForceNode>((d) => (centers[d.resource.categoryId] ?? centers.other).x).strength(
          0.08,
        ),
      )
      .force(
        'y',
        forceY<ForceNode>((d) => (centers[d.resource.categoryId] ?? centers.other).y).strength(
          0.08,
        ),
      )
      // Continue gently when every node already has a place instead of re-heating the layout.
      .alpha(allReused ? (resized ? 0.3 : 0.1) : reused > nodes.length / 2 ? 0.3 : 1);

    let raf = 0;
    const flush = () => {
      raf = 0;
      for (const node of nodes) {
        if (typeof node.x === 'number' && typeof node.y === 'number') {
          positions.set(node.id, { x: node.x, y: node.y });
        }
      }
      writePositions(nodes, links, nodeElsRef.current, linkElsRef.current);
    };
    simulation.on('tick', () => {
      if (!raf) raf = window.requestAnimationFrame(flush);
    });
    simulation.on('end', () => {
      if (!raf) raf = window.requestAnimationFrame(flush);
    });
    // Warm up a little so the first paint is not a pile in the middle; known positions need none.
    if (!allReused) simulation.tick(reused > 0 ? 10 : 30);
    flush();
    // New structure: React mounts the elements, the layout effect below places them.
    setGraph({ nodes, links });
    setTransform(() =>
      fitTransform(
        nodes.flatMap((node) =>
          typeof node.x === 'number' && typeof node.y === 'number'
            ? [{ x: node.x, y: node.y }]
            : [],
        ),
        size.width,
        size.height,
        FIT_MARGIN,
        MIN_SCALE,
      ),
    );

    return () => {
      simulation.stop();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [activeCategory, nodeSignature, edgeSignature, setTransform, size]);

  // Freshly mounted node/edge elements get their positions before the browser paints.
  useLayoutEffect(() => {
    writePositions(graph.nodes, graph.links, nodeElsRef.current, linkElsRef.current);
  }, [graph]);

  useEffect(() => {
    if (!announceZoomRef.current) return undefined;
    const handle = window.setTimeout(() => {
      announceZoomRef.current = false;
      setZoomAnnouncement(fmt(t.graph.zoom, { percent: zoomPercent }));
    }, ZOOM_ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [zoomPercent, t]);

  // Fresh measurement on every press (nodes stop mousedown from reaching the container).
  const startPress = useCallback((e: React.MouseEvent) => {
    const drag = dragRef.current;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.moved = 0;
    drag.pressed = true;
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    startPress(e);
    dragRef.current.originX = transformRef.current.x;
    dragRef.current.originY = transformRef.current.y;
    setIsDragging(true);
  };

  // Node presses bubble here too, so a drag starting on a node is still recognized as a drag.
  const handleMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag.pressed) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
    if (!isDragging) return;
    setTransform((prev) => ({ ...prev, x: drag.originX + dx, y: drag.originY + dy }));
  };

  const endDrag = () => {
    dragRef.current.pressed = false;
    setIsDragging(false);
  };
  const wasPan = () => dragRef.current.moved > DRAG_THRESHOLD_PX;

  const zoomBy = (factor: number) => {
    announceZoomRef.current = true;
    setTransform((prev) => {
      const scale = clampScale(prev.scale * factor);
      const ratio = scale / prev.scale;
      const cx = size.width / 2;
      const cy = size.height / 2;
      return { scale, x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio };
    });
  };

  const handlers = useMemo<NodeHandlers>(
    () => ({
      register: (id, el) => {
        if (el) nodeElsRef.current.set(id, el);
        else nodeElsRef.current.delete(id);
      },
      hover: setHoveredNodeId,
      focus: (id) => {
        setFocusedNodeId(id);
        // Keeps a keyboard-focused node on screen.
        const node = nodesRef.current.find((n) => n.id === id);
        if (!node || typeof node.x !== 'number' || typeof node.y !== 'number') return;
        const { x: nx, y: ny } = node;
        const { width, height } = viewSizeRef.current;
        setTransform((prev) => {
          const sx = nx * prev.scale + prev.x;
          const sy = ny * prev.scale + prev.y;
          const margin = 60;
          if (sx > margin && sx < width - margin && sy > margin && sy < height - margin) {
            return prev;
          }
          return { ...prev, x: width / 2 - nx * prev.scale, y: height / 2 - ny * prev.scale };
        });
      },
      blur: () => setFocusedNodeId(null),
      press: startPress,
      activate: (id, viaPointer) => {
        // A pointer press that turned into a pan does not select.
        if (viaPointer && dragRef.current.moved > DRAG_THRESHOLD_PX) return;
        onSelectRef.current(id);
      },
    }),
    [setTransform, startPress],
  );
  const registerLink = useCallback((id: string, el: SVGLineElement | null) => {
    if (el) linkElsRef.current.set(id, el);
    else linkElsRef.current.delete(id);
  }, []);

  const activeNodeId = hoveredNodeId ?? focusedNodeId;
  const activeNeighbours = activeNodeId ? adjacency.get(activeNodeId) : undefined;
  const labelAll = shown.length <= ALWAYS_LABEL_NODES || zoomedIn;

  return (
    <div
      ref={containerRef}
      className={cx(
        'relative h-full min-h-96 w-full select-none overflow-hidden rounded-lg border border-line-subtle bg-surface-1',
        isDragging ? 'cursor-grabbing' : 'cursor-grab',
      )}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onClick={() => {
        // A pan must not clear the selection.
        if (!wasPan()) onSelect(null);
      }}
    >
      <p id={hintId} className="sr-only">
        {t.graph.keyboardHint}
      </p>
      <svg
        className="h-full w-full overflow-visible"
        role="group"
        aria-label={t.graph.label}
        aria-describedby={hintId}
      >
        <g ref={viewportRef} data-graph-viewport="">
          {activeCategory === null &&
            clusterEdges.map((edge) => {
              const source = clusterCenters[edge.source];
              const target = clusterCenters[edge.target];
              return (
                <line
                  key={edge.id}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke="var(--border-strong)"
                  strokeWidth={1 + edge.strength * 2}
                  opacity={0.35 + edge.strength * 0.35}
                />
              );
            })}

          {activeCategory === null &&
            presentCategories.map((id) => {
              const count = categoryCounts.get(id) ?? 0;
              const radius =
                CLUSTER_MIN_RADIUS +
                Math.sqrt(count / maxCategoryCount) * (CLUSTER_MAX_RADIUS - CLUSTER_MIN_RADIUS);
              const center = clusterCenters[id];
              const style = CATEGORY_STYLE[id];
              const Icon = style.icon;
              return (
                <g
                  key={id}
                  role="button"
                  tabIndex={0}
                  aria-label={fmt(t.graph.categoryCluster, {
                    category: t.categories[id],
                    count,
                  })}
                  data-category-cluster={id}
                  className="cursor-pointer"
                  transform={`translate(${center.x},${center.y})`}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setActiveCategory(id);
                    onSelectRef.current(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    focusFirstNodeRef.current = true;
                    setActiveCategory(id);
                    onSelectRef.current(null);
                  }}
                >
                  <circle
                    r={radius + 7}
                    fill="var(--surface-2)"
                    stroke={style.color}
                    strokeWidth={1}
                    opacity={0.65}
                  />
                  <circle r={radius} fill="var(--surface-2)" stroke={style.color} strokeWidth={3} />
                  <Icon
                    x={-12}
                    y={-radius * 0.42 - 12}
                    width={24}
                    height={24}
                    color={style.color}
                    aria-hidden
                  />
                  <text
                    y={5}
                    textAnchor="middle"
                    fill="var(--text-primary)"
                    fontSize={12}
                    fontWeight={600}
                    className="pointer-events-none"
                  >
                    {t.categories[id]}
                  </text>
                  <text
                    y={24}
                    textAnchor="middle"
                    fill="var(--text-secondary)"
                    fontSize={12}
                    fontWeight={600}
                    className="pointer-events-none"
                  >
                    {count}
                  </text>
                </g>
              );
            })}

          {activeCategory !== null &&
            graph.links.map((link) => {
              const sourceId = endpointId(link.source);
              const targetId = endpointId(link.target);
              const isHighlighted =
                sourceId === activeNodeId ||
                targetId === activeNodeId ||
                sourceId === selectedResourceId ||
                targetId === selectedResourceId;
              return (
                <GraphEdge
                  key={link.id}
                  id={link.id}
                  strength={link.strength}
                  isHighlighted={isHighlighted}
                  register={registerLink}
                />
              );
            })}

          {activeCategory !== null &&
            graph.nodes.map((node) => {
              const resource = resourceById.get(node.id) ?? node.resource;
              const isSelected = node.id === selectedResourceId;
              const isActive = node.id === activeNodeId;
              const isNeighbour = Boolean(activeNeighbours?.has(node.id));
              const isDimmed = activeNodeId !== null && !isActive && !isNeighbour && !isSelected;
              return (
                <GraphNode
                  key={node.id}
                  id={node.id}
                  resource={resource}
                  ariaLabel={fmt(t.graph.node, {
                    title: resource.title,
                    category: t.categories[resource.categoryId],
                  })}
                  mediaReady={mediaReady}
                  isSelected={isSelected}
                  isActive={isActive}
                  isFocused={node.id === focusedNodeId}
                  isDimmed={isDimmed}
                  showLabel={labelAll || isSelected || isActive || isNeighbour}
                  handlers={handlers}
                />
              );
            })}
        </g>
      </svg>

      <div className="absolute left-4 top-4 flex max-w-lg flex-col gap-2">
        <nav
          aria-label={t.graph.breadcrumb}
          className={cx(INSET_SURFACE, 'flex items-center gap-1 px-2 py-1.5 text-sm shadow-sm')}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={cx(
              'rounded px-2 py-1 transition-colors hover:bg-surface-3',
              activeCategory === null ? 'font-semibold text-fg-primary' : 'text-accent-text',
            )}
            onClick={() => {
              setActiveCategory(null);
              onSelectRef.current(null);
            }}
          >
            {t.graph.allBookmarks}
          </button>
          {activeCategory !== null && (
            <>
              <ChevronRight size={14} aria-hidden className="text-fg-muted" />
              <button
                type="button"
                className={cx(
                  'rounded px-2 py-1 transition-colors hover:bg-surface-3',
                  selectedResourceId ? 'text-accent-text' : 'font-semibold text-fg-primary',
                )}
                onClick={() => onSelectRef.current(null)}
              >
                {t.categories[activeCategory]}
              </button>
            </>
          )}
          {selectedResourceId && resourceById.has(selectedResourceId) && (
            <>
              <ChevronRight size={14} aria-hidden className="text-fg-muted" />
              <span className="max-w-48 truncate px-2 py-1 font-semibold text-fg-primary">
                {resourceById.get(selectedResourceId)?.title}
              </span>
            </>
          )}
        </nav>
        <p className="pointer-events-none flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg-secondary shadow-sm">
          {activeCategory !== null &&
            !selectedResourceId &&
            categoryResources.length > shown.length && (
              <Info size={14} aria-hidden className="shrink-0 text-accent-text" />
            )}
          {activeCategory === null
            ? t.graph.overviewHint
            : selectedResourceId && resourceById.has(selectedResourceId)
              ? fmt(t.graph.neighbourhoodCount, { count: Math.max(0, shown.length - 1) })
              : fmt(t.graph.categoryCount, {
                  shown: shown.length,
                  count: categoryResources.length,
                })}
        </p>
        {activeCategory === null && (
          <ul
            aria-label={t.graph.legend}
            className={cx(
              INSET_SURFACE,
              'flex flex-wrap gap-x-3 gap-y-1 px-3 py-2 text-xs text-fg-secondary',
            )}
          >
            {presentCategories.map((id) => (
              <li key={id} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: CATEGORY_STYLE[id].color }}
                />
                {t.categories[id]}
              </li>
            ))}
          </ul>
        )}
      </div>

      {activeCategory !== null && (
        <div
          className="absolute bottom-4 right-4 flex items-center gap-1 rounded-md border border-line bg-surface-2 p-1 shadow-md"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <IconButton label={t.graph.zoomOut} icon={Minus} onClick={() => zoomBy(1 / 1.25)} />
          <span aria-hidden className="w-12 text-center text-sm tabular-nums text-fg-secondary">
            {fmt(t.graph.zoomPercent, { percent: zoomPercent })}
          </span>
          {/* Announced once after the zoom buttons settle; wheel zoom stays silent. */}
          <span role="status" className="sr-only">
            {zoomAnnouncement}
          </span>
          <IconButton label={t.graph.zoomIn} icon={Plus} onClick={() => zoomBy(1.25)} />
          <IconButton
            label={t.graph.resetView}
            icon={Maximize2}
            onClick={() => {
              announceZoomRef.current = true;
              const points = [...positionsRef.current.values()];
              setTransform(() =>
                fitTransform(points, size.width, size.height, FIT_MARGIN, MIN_SCALE),
              );
            }}
          />
        </div>
      )}
    </div>
  );
};

export default GraphView;
