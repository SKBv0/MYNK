// Fails when an artifact names the build machine: that leaks the developer's account and paths.
// Usage: node scripts/check-artifact-paths.mjs <file-or-dir>...
// A target that does not exist is skipped, but scanning nothing at all is an error.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortPath } from './lib/toolchain.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const user = userInfo().username;
const host = hostname();
const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
const exeSuffix = process.platform === 'win32' ? '.exe' : '';

// Both separator spellings, because a C compiler and rustc disagree about them on Windows.
function spellings(text) {
  return text.includes('\\') || text.includes('/') ? [text, text.replaceAll('\\', '/')] : [text];
}

const needles = [];
for (const [label, text] of [
  ['home directory', homedir()],
  ['home directory (8.3)', shortPath(homedir())],
  ['cargo home', cargoHome],
  ['cargo home (8.3)', shortPath(cargoHome)],
  ['repo root', root],
  ['repo root (8.3)', shortPath(root)],
  ['user name', `\\${user}\\`],
  ['host name', `${host}\\`],
]) {
  if (!text || text.length < 3) continue;
  for (const spelling of new Set(spellings(text))) needles.push([label, spelling]);
}

// The file the caller meant: the path itself, or the same name with this platform's exe suffix.
function resolveTarget(target) {
  const path = resolve(target);
  if (existsSync(path)) return path;
  if (exeSuffix && !extname(path)) {
    const withSuffix = path + exeSuffix;
    if (existsSync(withSuffix)) return withSuffix;
  }
  return null;
}

function* files(path) {
  const info = statSync(path);
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) yield* files(join(path, entry));
  } else if (!path.endsWith('.sig')) {
    yield path;
  }
}

let failed = 0;
let scanned = 0;
const targets = process.argv.slice(2);
for (const target of targets) {
  const path = resolveTarget(target);
  if (!path) continue;
  for (const file of files(path)) {
    scanned += 1;
    const lower = readFileSync(file).toString('latin1').toLowerCase();
    for (const [label, needle] of needles) {
      const text = needle.toLowerCase();
      // UTF-16 is searched as its interleaved bytes so an odd offset cannot hide a match.
      const wide = Buffer.from(text, 'utf16le').toString('latin1');
      const ascii = lower.split(text).length - 1;
      const utf16 = lower.split(wide).length - 1;
      if (!ascii && !utf16) continue;
      failed += 1;
      console.error(
        `${file}: ${label} "${needle}" appears ${ascii} time(s) as ASCII, ${utf16} as UTF-16`,
      );
    }
  }
}

if (failed) {
  console.error(
    `\nBuild-machine paths found in ${failed} place(s). Release builds must run through scripts/build-env.mjs.`,
  );
  process.exit(1);
}
if (!scanned) {
  console.error(
    `No artifact was scanned. None of these exist: ${targets.join(', ') || '(no arguments)'}`,
  );
  process.exit(1);
}
console.log(`No build-machine paths in ${scanned} artifact file(s).`);
