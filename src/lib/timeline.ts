/** Day buckets for the timeline; weeks start on Monday. Input must be sorted newest first. */
export type TimelineGroupKey = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'month';

export interface TimelineGroup<T> {
  id: string;
  key: TimelineGroupKey;
  items: T[];
}

/** Local midnight `daysBefore` days before `ms`; `setDate` steps whole days, so DST cannot shift it. */
const startOfDay = (ms: number, daysBefore = 0): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  if (daysBefore !== 0) d.setDate(d.getDate() - daysBefore);
  return d.getTime();
};

export const bucketOf = (createdAt: number, now: number): { id: string; key: TimelineGroupKey } => {
  const today = startOfDay(now);
  const weekday = (new Date(today).getDay() + 6) % 7; // Monday = 0
  const weekStart = startOfDay(today, weekday);
  if (createdAt >= today) return { id: 'today', key: 'today' };
  if (createdAt >= startOfDay(today, 1)) return { id: 'yesterday', key: 'yesterday' };
  if (createdAt >= weekStart) return { id: 'thisWeek', key: 'thisWeek' };
  if (createdAt >= startOfDay(weekStart, 7)) return { id: 'lastWeek', key: 'lastWeek' };
  const d = new Date(createdAt);
  return { id: `m-${d.getFullYear()}-${d.getMonth()}`, key: 'month' };
};

export const groupByBucket = <T extends { createdAt: number }>(
  sorted: readonly T[],
  now: number,
): TimelineGroup<T>[] => {
  const groups: TimelineGroup<T>[] = [];
  for (const item of sorted) {
    const bucket = bucketOf(item.createdAt, now);
    const last = groups[groups.length - 1];
    if (last && last.id === bucket.id) last.items.push(item);
    else groups.push({ ...bucket, items: [item] });
  }
  return groups;
};
