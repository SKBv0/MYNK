import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Resource } from '../types';
import SmartImage from './SmartImage';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { useScrollViewport } from '../hooks/useScrollViewport';
import { sortByCreatedAt } from '../store/selectors';
import { resourcePreviews } from '../lib/media';
import { sourceLabel } from '../services/resourceMedia';
import { formatDate, formatTime } from '../lib/format';
import { fmt } from '../lib/text';
import { groupByBucket, type TimelineGroupKey } from '../lib/timeline';
import { Badge, cx } from './ui';
import { isoDateTime } from './renderHelpers';

interface TimelineViewProps {
  resources: Resource[];
  onSelect: (id: string) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

const HEADER_HEIGHT = 44;
const ITEM_HEIGHT = 68;
const OVERSCAN_PX = 600;

interface Group {
  key: string;
  label: string;
  count: number;
  top: number;
  height: number;
}

type Row =
  | { kind: 'header'; key: string; group: number; top: number }
  | {
      kind: 'item';
      key: string;
      group: number;
      resource: Resource;
      top: number;
      /** 1-based position inside its day group. */
      position: number;
      showDay: boolean;
    };

/** Index of the first row that reaches `start` (rows are sorted by `top`). */
const firstRowFrom = (rows: readonly Row[], start: number): number => {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const row = rows[mid];
    if (row && row.top + ITEM_HEIGHT < start) low = mid + 1;
    else high = mid;
  }
  return low;
};

/** Current time, refreshed just after each local midnight so "Today" does not go stale. */
const useDayClock = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 1, 0);
    const timer = window.setTimeout(() => setNow(Date.now()), midnight.getTime() - Date.now());
    return () => window.clearTimeout(timer);
  }, [now]);
  return now;
};

const TimelineItem: React.FC<{
  resource: Resource;
  showDay: boolean;
  onSelect: (id: string) => void;
}> = React.memo(({ resource, showDay, onSelect }) => {
  const { t, locale } = useTranslation();
  const mediaReady = useAppStore((s) => s.mediaReady);
  const isSelected = useAppStore((s) => s.selectedResourceId === resource.id);
  const previews = useMemo(() => resourcePreviews(resource, mediaReady), [resource, mediaReady]);
  const iso = isoDateTime(resource.createdAt);
  return (
    <button
      type="button"
      onClick={() => onSelect(resource.id)}
      aria-current={isSelected || undefined}
      className={cx(
        'flex h-full w-full items-center gap-4 rounded-md border px-3 text-left transition-colors duration-fast',
        isSelected
          ? 'border-accent bg-surface-2'
          : 'border-transparent hover:border-line hover:bg-surface-2',
      )}
    >
      {iso ? (
        <time
          dateTime={iso}
          className="flex w-16 shrink-0 flex-col text-sm tabular-nums text-fg-muted"
        >
          {showDay && (
            <span className="truncate text-xs">
              {formatDate(resource.createdAt, locale, { day: 'numeric', month: 'short' })}
            </span>
          )}
          <span>{formatTime(resource.createdAt, locale)}</span>
        </time>
      ) : (
        // A stored date outside the representable range shows no time.
        <span aria-hidden className="w-16 shrink-0" />
      )}
      <SmartImage
        sources={previews}
        className="h-11 w-11 shrink-0 rounded-sm object-cover"
        alt=""
        loading="lazy"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium text-fg">{resource.title}</span>
        <span className="block truncate text-sm text-fg-muted">{sourceLabel(resource)}</span>
      </span>
      <Badge className="hidden shrink-0 md:inline-flex">{t.categories[resource.categoryId]}</Badge>
    </button>
  );
});
TimelineItem.displayName = 'TimelineItem';

/** Bookmarks grouped by day, windowed so only visible rows mount. */
const TimelineView: React.FC<TimelineViewProps> = ({ resources, onSelect, scrollContainerRef }) => {
  const { t, locale } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const { viewport } = useScrollViewport(scrollContainerRef, listRef);
  const now = useDayClock();

  const headingId = useId();
  const { groups, rows, totalHeight } = useMemo(() => {
    const groupLabel = (key: TimelineGroupKey, sample: number): string => {
      if (key === 'today') return t.timeline.today;
      if (key === 'yesterday') return t.timeline.yesterday;
      if (key === 'thisWeek') return t.timeline.thisWeek;
      if (key === 'lastWeek') return t.timeline.lastWeek;
      return isoDateTime(sample)
        ? formatDate(sample, locale, { month: 'long', year: 'numeric' })
        : '';
    };
    const buckets = groupByBucket(sortByCreatedAt(resources), now);
    const groupsOut: Group[] = [];
    const out: Row[] = [];
    let top = 0;
    for (const bucket of buckets) {
      const first = bucket.items[0];
      if (!first) continue;
      const group = groupsOut.length;
      groupsOut.push({
        key: bucket.id,
        label: groupLabel(bucket.key, first.createdAt),
        count: bucket.items.length,
        top,
        height: HEADER_HEIGHT + bucket.items.length * ITEM_HEIGHT,
      });
      out.push({ kind: 'header', key: `h-${bucket.id}`, group, top });
      top += HEADER_HEIGHT;
      // Past yesterday a bucket spans several days, so each row carries its own date.
      const showDay = bucket.key !== 'today' && bucket.key !== 'yesterday';
      for (const [index, resource] of bucket.items.entries()) {
        out.push({
          kind: 'item',
          key: resource.id,
          group,
          resource,
          top,
          position: index + 1,
          showDay,
        });
        top += ITEM_HEIGHT;
      }
    }
    return { groups: groupsOut, rows: out, totalHeight: top };
  }, [resources, t, locale, now]);

  const start = viewport.scrollTop - viewport.offsetTop - OVERSCAN_PX;
  const end = viewport.scrollTop - viewport.offsetTop + viewport.height + OVERSCAN_PX;
  // Binary search for the window start: a linear scan would touch every row per scroll frame.
  const visibleItems = new Map<number, Extract<Row, { kind: 'item' }>[]>();
  for (let i = firstRowFrom(rows, start); i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.top > end) break;
    const items = visibleItems.get(row.group) ?? [];
    if (row.kind === 'item') items.push(row);
    visibleItems.set(row.group, items);
  }

  // Each day group is its own list under its heading; the heading stays while any row shows.
  return (
    <div
      ref={listRef}
      role="group"
      aria-label={t.timeline.label}
      className="relative mx-auto max-w-4xl"
      style={{ height: totalHeight }}
    >
      {[...visibleItems].map(([index, items]) => {
        const group = groups[index];
        if (!group) return null;
        const id = `${headingId}-${index}`;
        return (
          <div
            key={group.key}
            className="absolute inset-x-0"
            style={{ top: group.top, height: group.height }}
          >
            <div
              className="flex items-end justify-between border-b border-line-subtle pb-2"
              style={{ height: HEADER_HEIGHT }}
            >
              <h2 id={id} className="text-base font-semibold text-fg">
                {group.label}
              </h2>
              <span className="text-sm text-fg-muted">
                {fmt(t.timeline.groupCount, { count: group.count })}
              </span>
            </div>
            <div role="list" aria-labelledby={id}>
              {items.map((row) => (
                <div
                  key={row.key}
                  role="listitem"
                  // Only a window of rows is mounted; position and size keep "12 of 300" right.
                  aria-posinset={row.position}
                  aria-setsize={group.count}
                  className="absolute inset-x-0 py-1"
                  style={{ top: row.top - group.top, height: ITEM_HEIGHT }}
                >
                  <TimelineItem resource={row.resource} showDay={row.showDay} onSelect={onSelect} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default TimelineView;
