import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lowerCaseTag, normalizeSearchText, normalizeTags, tokenize } from './text';

const CATALOG_DIR = resolve(__dirname, '../../src-tauri/src/catalog');
const FOLD_TABLES = resolve(CATALOG_DIR, 'fold_tables.rs');
const RUNTIME_UNICODE = process.versions.unicode ?? 'unknown';
/** Unicode version the committed tables were generated from; another runtime cannot rebuild them. */
const TABLES_UNICODE = /Unicode (\S+) data/.exec(readFileSync(FOLD_TABLES, 'utf8'))?.[1];

type Range = [number, number];

const hex = (cp: number): string => `0x${cp.toString(16).toUpperCase()}`;

const addToRanges = (ranges: Range[], cp: number): void => {
  const last = ranges[ranges.length - 1];
  if (last && last[1] === cp - 1) last[1] = cp;
  else ranges.push([cp, cp]);
};

const rustList = (items: string[], perLine: number): string => {
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += perLine) {
    lines.push(`    ${items.slice(i, i + perLine).join(', ')},`);
  }
  return lines.join('\n');
};

/** The Rust tables that let `catalog::text` fold text exactly as `normalizeSearchText` does. */
const foldTablesSource = (): string => {
  const marks: Range[] = [];
  const nonWord: Range[] = [];
  const bases: Range[] = [];
  const sequences: [number, number[]][] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    if (/\p{M}/u.test(c)) {
      addToRanges(marks, cp);
      continue;
    }
    if (/\p{Alphabetic}/u.test(c) && !/[\p{L}\p{N}]/u.test(c)) addToRanges(nonWord, cp);
    // Hangul syllables decompose by formula; the Rust side computes them.
    if (cp >= 0xac00 && cp <= 0xd7a3) continue;
    if (c.toLocaleLowerCase('tr') !== c) continue;
    const base = [...c.normalize('NFD').replace(/\p{M}/gu, '')].map((ch) => ch.codePointAt(0) ?? 0);
    if (base.length === 1 && base[0] === cp) continue;
    if (base.length === 1) bases.push([cp, base[0] ?? 0]);
    else sequences.push([cp, base]);
  }
  const pairs = (list: Range[]) => list.map(([a, b]) => `(${hex(a)}, ${hex(b)})`);
  return `//! Unicode ${RUNTIME_UNICODE} data for \`super::text\`, generated from the renderer's rules (\`normalize('NFD')\`,
//! \`\\p{M}\`, \`\\p{L}\`/\`\\p{N}\`). Regenerate: \`UPDATE_FOLD_TABLES=1 npx vitest run src/lib/text.test.ts\`.

/// Code point ranges of \`\\p{M}\`, sorted.
#[rustfmt::skip]
pub const MARK_RANGES: &[(u32, u32)] = &[
${rustList(pairs(marks), 4)}
];

/// Alphabetic yet neither \`\\p{L}\` nor \`\\p{N}\` (circled and squared letters), sorted.
#[rustfmt::skip]
pub const NON_WORD_ALPHABETIC: &[(u32, u32)] = &[
${rustList(pairs(nonWord), 4)}
];

/// Lowercase character to its base letter once decomposed and stripped of marks, sorted.
#[rustfmt::skip]
pub const BASE_LETTERS: &[(u32, u32)] = &[
${rustList(pairs(bases), 4)}
];

/// The few characters whose base is more than one character, sorted.
#[rustfmt::skip]
pub const BASE_SEQUENCES: &[(u32, &[u32])] = &[
${rustList(
  sequences.map(([cp, base]) => `(${hex(cp)}, &[${base.map(hex).join(', ')}])`),
  1,
)}
];
`;
};

type TextVector = { input: string; normalized: string; tokens: string[] };

describe('text normalization parity with Rust', () => {
  it('shares every vector with catalog/text.rs', () => {
    const vectors = JSON.parse(
      readFileSync(resolve(CATALOG_DIR, 'text_vectors.json'), 'utf8'),
    ) as TextVector[];
    expect(vectors.length).toBeGreaterThan(0);
    for (const { input, normalized, tokens } of vectors) {
      expect(normalizeSearchText(input), input).toBe(normalized);
      expect(tokenize(input), input).toEqual(tokens);
    }
  });

  const update = Boolean(process.env.UPDATE_FOLD_TABLES);
  // Locally another Unicode version (an older Node) would rebuild different tables; CI must match.
  it.skipIf(!update && !process.env.CI && TABLES_UNICODE !== RUNTIME_UNICODE)(
    'keeps the Rust fold tables in step with this runtime',
    () => {
      const expected = foldTablesSource();
      if (update) writeFileSync(FOLD_TABLES, expected);
      expect(readFileSync(FOLD_TABLES, 'utf8').replace(/\r\n/g, '\n')).toBe(expected);
    },
    // Walking every code point takes seconds when the suite runs on busy workers.
    30_000,
  );
});

describe('normalizeTags', () => {
  it('lowercases English tags without the Turkish dotless i', () => {
    expect(normalizeTags(['AI', 'API', 'SQL Injection', 'LINUX'])).toEqual([
      'ai',
      'api',
      'sql injection',
      'linux',
    ]);
  });

  it('keeps Turkish letters and maps the dotted capital İ to i', () => {
    expect(normalizeTags(['kapı', 'Şehir', 'ĞÜÇ', 'İstanbul', 'ŞEHİR'])).toEqual([
      'kapı',
      'şehir',
      'ğüç',
      'istanbul',
    ]);
    expect(lowerCaseTag('İ')).toBe('i');
    expect(lowerCaseTag('ı')).toBe('ı');
  });

  it('trims, collapses spaces, de-duplicates and caps', () => {
    expect(normalizeTags(['  Ai ', 'AI', 'ai', 'a   b'])).toEqual(['ai', 'a b']);
    expect(normalizeTags(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });
});
