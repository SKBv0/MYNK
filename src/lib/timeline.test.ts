import { describe, expect, it } from 'vitest';
import { bucketOf, groupByBucket } from './timeline';

// Thursday 2026-09-10 15:00 local time.
const now = new Date(2026, 8, 10, 15, 0, 0).getTime();
const at = (month: number, day: number, hour = 12) => new Date(2026, month, day, hour).getTime();

describe('timeline buckets', () => {
  it('puts dates in today / yesterday / this week / last week / month buckets', () => {
    expect(bucketOf(at(8, 10, 9), now).key).toBe('today');
    expect(bucketOf(at(8, 9), now).key).toBe('yesterday');
    expect(bucketOf(at(8, 7), now).key).toBe('thisWeek'); // Monday
    expect(bucketOf(at(8, 3), now).key).toBe('lastWeek');
    expect(bucketOf(at(7, 20), now)).toEqual({ id: 'm-2026-7', key: 'month' });
  });

  it('runs in a zone with daylight saving time (vitest.config.ts sets it)', () => {
    expect(new Date(2026, 2, 9).getTimezoneOffset()).not.toBe(
      new Date(2026, 2, 7).getTimezoneOffset(),
    );
  });

  // The day after the US spring-forward: a fixed 24 h step lands at 01:00, not local midnight.
  it('splits the buckets at local midnight, not a fixed 24 hours', () => {
    const dstNow = new Date(2026, 2, 9, 15).getTime();
    expect(bucketOf(new Date(2026, 2, 8).getTime(), dstNow).key).toBe('yesterday');
    expect(bucketOf(new Date(2026, 2, 8).getTime() - 1, dstNow).key).toBe('lastWeek');
    expect(bucketOf(new Date(2026, 2, 2).getTime(), dstNow).key).toBe('lastWeek');
    expect(bucketOf(new Date(2026, 2, 2).getTime() - 1, dstNow).key).toBe('month');
  });

  it('groups a newest-first list without reordering', () => {
    const items = [at(8, 10), at(8, 10, 8), at(8, 9), at(7, 1), at(6, 30)].map((createdAt) => ({
      createdAt,
    }));
    const groups = groupByBucket(items, now);
    expect(groups.map((g) => [g.id, g.items.length])).toEqual([
      ['today', 2],
      ['yesterday', 1],
      ['m-2026-7', 1],
      ['m-2026-6', 1],
    ]);
  });
});
