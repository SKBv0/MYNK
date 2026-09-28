import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './ipc';
import { CATEGORY_IDS } from './ipcTypes';

const rustSource = (path: string): string =>
  readFileSync(resolve(__dirname, '../../src-tauri/src', path), 'utf8');

// If this drifts from Rust's copy, the model can return an id the UI silently maps to "other".
describe('CATEGORY_IDS parity with Rust', () => {
  it('matches analyze/mod.rs exactly, order included', () => {
    const source = rustSource('analyze/mod.rs');
    const block = /pub const CATEGORY_IDS: \[&str; (\d+)\] = \[([\s\S]*?)\];/.exec(source);
    expect(block, 'CATEGORY_IDS not found in analyze/mod.rs').not.toBeNull();
    const rustIds = [...(block?.[2] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(Number(block![1])).toBe(rustIds.length);
    expect(rustIds).toEqual([...CATEGORY_IDS]);
  });
});

// A code Rust sends but the renderer does not know falls back to the generic error sentence.
describe('ERROR_CODES parity with Rust', () => {
  it('lists exactly the codes of error.rs', () => {
    const source = rustSource('error.rs');
    const values = new Map(
      [...source.matchAll(/const (\w+): &str = "([^"]+)";/g)].map((m) => [m[1], m[2]]),
    );
    const block = /pub const ERROR_CODES: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(source);
    expect(block, 'ERROR_CODES not found in error.rs').not.toBeNull();
    const rustCodes = (block?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => values.get(name) ?? name);
    expect([...rustCodes].sort()).toEqual([...ERROR_CODES].sort());
  });
});
