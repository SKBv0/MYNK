import { describe, expect, it } from 'vitest';
import { formatDate, formatRelativeTime, formatTime } from './format';

describe('date helpers with invalid timestamps', () => {
  it('return an empty string instead of throwing', () => {
    for (const value of [Number.NaN, 1e20, -1e20, Number.POSITIVE_INFINITY]) {
      expect(() => formatDate(value, 'en-US')).not.toThrow();
      expect(formatDate(value, 'en-US')).toBe('');
      expect(formatTime(value, 'tr-TR')).toBe('');
      expect(formatRelativeTime(value, Date.UTC(2026, 0, 1), 'en-US')).toBe('');
    }
  });

  it('still format valid dates', () => {
    expect(formatDate(Date.UTC(2026, 0, 15), 'en-US')).toContain('2026');
  });
});
