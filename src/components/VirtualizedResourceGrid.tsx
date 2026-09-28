import React, { useEffect, useRef } from 'react';
import ResourceCard, { CARD_HEIGHT } from './ResourceCard';
import type { Resource } from '../types';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useScrollViewport } from '../hooks/useScrollViewport';
import { selectedIdSet } from '../store/selectors';
import { GRID_GAP, cardWidthFor, columnsFor, rowWindow } from './gridLayout';
import { Skeleton } from './ui';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
/** Keys that scroll the container; any of them ends auto-follow like a wheel or touch does. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

interface VirtualizedResourceGridProps {
  resources: Resource[];
  onRefreshPreview?: ((id: string) => void) | undefined;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

const ROW_HEIGHT = CARD_HEIGHT + GRID_GAP;

interface GridCellProps {
  resource: Resource;
  top: number;
  left: number;
  width: number;
  /** 1-based position in the whole list and its length (only a window is mounted). */
  position: number;
  setSize: number;
  batchMode: boolean;
  onRefreshPreview?: ((id: string) => void) | undefined;
}

/** One positioned card. Subscribes only to its own flags. */
const GridCell: React.FC<GridCellProps> = React.memo(
  ({ resource, top, left, width, position, setSize, batchMode, onRefreshPreview }) => {
    const id = resource.id;
    const isSelected = useAppStore((s) => s.selectedResourceId === id);
    const isBatched = useAppStore((s) => selectedIdSet(s.batchSelectedIds).has(id));
    const isRefreshing = useAppStore((s) => s.busy.preview.includes(id));
    const selectResource = useAppStore((s) => s.selectResource);
    const toggleBatch = useAppStore((s) => s.toggleBatch);

    return (
      <li
        className="absolute list-none"
        style={{ top, left, width, height: CARD_HEIGHT }}
        aria-posinset={position}
        aria-setsize={setSize}
      >
        <ResourceCard
          resource={resource}
          isSelected={isSelected}
          isBatched={isBatched}
          batchMode={batchMode}
          onSelect={selectResource}
          onToggleBatch={toggleBatch}
          onRefreshPreview={onRefreshPreview}
          isRefreshingPreview={isRefreshing}
        />
      </li>
    );
  },
);
GridCell.displayName = 'GridCell';

/** Placeholder grid shown while the library loads. */
export const GridSkeleton: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div role="status" aria-label={t.common.loading} className="grid grid-cols-cards gap-5">
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          className="overflow-hidden rounded-lg border border-line-subtle bg-surface-1"
        >
          <Skeleton className="h-32 rounded-none" />
          <div className="space-y-3 p-4">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
};

/** Windowed card grid: renders only the rows in view, columns derived from the container width. */
const VirtualizedResourceGrid: React.FC<VirtualizedResourceGridProps> = ({
  resources,
  onRefreshPreview,
  scrollContainerRef,
}) => {
  const { t } = useTranslation();
  const listRef = useRef<HTMLUListElement>(null);
  const batchMode = useAppStore((s) => s.batchSelectedIds.length > 0);
  const { viewport, measureAttempt } = useScrollViewport(scrollContainerRef, listRef, {
    trackWidth: true,
  });

  const columns = columnsFor(viewport.width);
  const itemWidth = cardWidthFor(viewport.width, columns);
  const rowCount = Math.ceil(resources.length / columns);
  const totalHeight = rowCount > 0 ? rowCount * ROW_HEIGHT - GRID_GAP : 0;

  // Scrolls each newly analyzed row into view until the user scrolls by hand; re-arms next run.
  // A run the user did not start (agent inbox) never moves the view.
  const analyzing = useAppStore((s) => s.busy.enrich);
  const inBackground = useAppStore((s) => s.enrichInBackground);
  const followId = analyzing[analyzing.length - 1];
  const followRef = useRef(false);
  const wasRunningRef = useRef(false);
  const reduceMotion = useMediaQuery(REDUCED_MOTION_QUERY);

  useEffect(() => {
    const running = analyzing.length > 0 && !inBackground;
    if (running !== wasRunningRef.current) followRef.current = running;
    wasRunningRef.current = running;
  }, [analyzing, inBackground]);

  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl) return;
    const stop = () => {
      followRef.current = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) stop();
    };
    scrollEl.addEventListener('wheel', stop, { passive: true });
    scrollEl.addEventListener('touchmove', stop, { passive: true });
    scrollEl.addEventListener('keydown', onKey);
    return () => {
      scrollEl.removeEventListener('wheel', stop);
      scrollEl.removeEventListener('touchmove', stop);
      scrollEl.removeEventListener('keydown', onKey);
    };
  }, [scrollContainerRef, measureAttempt]);

  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!followId || !followRef.current || !scrollEl) return;
    const index = resources.findIndex((r) => r.id === followId);
    if (index < 0) return;
    const cardTop = viewport.offsetTop + Math.floor(index / columns) * ROW_HEIGHT;
    const visibleFrom = scrollEl.scrollTop;
    const visibleTo = visibleFrom + scrollEl.clientHeight;
    if (cardTop >= visibleFrom && cardTop + CARD_HEIGHT <= visibleTo) return;
    scrollEl.scrollTo({
      top: Math.max(0, cardTop - GRID_GAP),
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
    // Only a newly started analysis moves the view; layout changes alone must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followId]);

  const { startRow, endRow } = rowWindow({
    relativeTop: viewport.scrollTop - viewport.offsetTop,
    viewportHeight: viewport.height,
    rowHeight: ROW_HEIGHT,
    rowCount,
  });

  const cells: React.ReactNode[] = [];
  if (viewport.width > 0) {
    for (let row = startRow; row <= endRow; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        const resource = resources[index];
        if (!resource) break;
        cells.push(
          <GridCell
            key={resource.id}
            resource={resource}
            top={row * ROW_HEIGHT}
            left={column * (itemWidth + GRID_GAP)}
            width={itemWidth}
            position={index + 1}
            setSize={resources.length}
            batchMode={batchMode}
            onRefreshPreview={onRefreshPreview}
          />,
        );
      }
    }
  }

  return (
    <ul
      ref={listRef}
      aria-label={t.card.gridLabel}
      className="relative"
      style={{ height: totalHeight }}
      data-clear-selection
    >
      {cells}
    </ul>
  );
};

export default VirtualizedResourceGrid;
