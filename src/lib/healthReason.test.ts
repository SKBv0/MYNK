import { describe, expect, it } from 'vitest';
import { healthReason } from './healthReason';
import { translations } from '../translations';

const { en, tr } = translations;
const dead = { status: 'dead' as const, checkedAt: 1 };

describe('healthReason', () => {
  it('names common HTTP statuses and falls back to the bare code', () => {
    expect(healthReason({ ...dead, httpStatus: 404, errorKind: 'http' }, en)).toBe('404 Not found');
    expect(healthReason({ ...dead, httpStatus: 410 }, tr)).toBe('410 Kaldırıldı');
    expect(healthReason({ ...dead, httpStatus: 418, errorKind: 'http' }, en)).toBe('418');
  });

  it('translates the error kind when there is no HTTP status', () => {
    expect(healthReason({ ...dead, errorKind: 'dns' }, en)).toBe('Address not found');
    expect(healthReason({ ...dead, errorKind: 'timeout' }, tr)).toBe('Zaman aşımı');
  });

  it('has nothing to say about a healthy record', () => {
    expect(healthReason({ status: 'alive', checkedAt: 1, httpStatus: 200 }, en)).toBeNull();
    expect(healthReason({ status: 'unknown', checkedAt: null }, en)).toBeNull();
  });
});
