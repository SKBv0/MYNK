// Toolchain facts the build scripts share, so the path remapper and its checker agree on them.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** The triple `rustc -vV` reports as its host; throws when rustc is missing or silent. */
export function hostTriple() {
  const line = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text.startsWith('host:'));
  if (!line) throw new Error('`rustc -vV` did not report a host triple.');
  return line.slice('host:'.length).trim();
}

/** The 8.3 spelling of an existing Windows path, or '' when it has none (cmake hands it to MSVC). */
export function shortPath(path) {
  if (process.platform !== 'win32' || !path || !existsSync(path)) return '';
  let out = '';
  try {
    out = execSync(`for %I in ("${path}") do @echo %~sI`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
  if (!out || out.toLowerCase() === path.toLowerCase() || !existsSync(out)) return '';
  return out;
}
