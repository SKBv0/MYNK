import { describe, expect, it } from 'vitest';
import { translations } from '../translations';

/** Every `{name}` placeholder of each string, keyed by its dotted path. */
const placeholders = (node: unknown, path = '', out = new Map<string, string[]>()) => {
  if (typeof node === 'string') {
    const names = [...node.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '');
    out.set(path, [...new Set(names)].sort());
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      placeholders(value, path ? `${path}.${key}` : key, out);
    }
  }
  return out;
};

describe('translations', () => {
  it('uses the same placeholders in English and Turkish', () => {
    const en = placeholders(translations.en);
    const tr = placeholders(translations.tr);
    const mismatches = [...en]
      .filter(([path, names]) => JSON.stringify(tr.get(path)) !== JSON.stringify(names))
      .map(([path, names]) => `${path}: en {${names.join(', ')}} tr {${tr.get(path)?.join(', ')}}`);
    expect(mismatches).toEqual([]);
    expect([...tr.keys()].filter((path) => !en.has(path))).toEqual([]);
  });
});
