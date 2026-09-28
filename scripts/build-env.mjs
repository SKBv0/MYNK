// Keeps the builder's paths (cargo home, toolchain, repo root) out of release artifacts.
// Usage: node scripts/build-env.mjs [--check=a,b] <command> [args...]
//        node scripts/build-env.mjs --github-env   (exports the flags for a CI runner)

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hostTriple, shortPath } from './lib/toolchain.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'MYNK_BUILD_ENV';
// Cargo's whitespace-free flag encoding; a space in a path would otherwise split a flag in two.
const ENCODED_SEP = '\x1f';

function run(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function buildFlags() {
  const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
  const toolchain = run('rustc', ['--print', 'sysroot']);
  const triple = hostTriple();
  const pairs = [];
  const seen = new Set();
  const add = (from, to) => {
    const key = (from || '').toLowerCase();
    if (!from || seen.has(key)) return;
    seen.add(key);
    pairs.push([from.replace(/[\\/]+$/, ''), to]);
  };
  add(cargoHome, '/cargo');
  add(shortPath(cargoHome), '/cargo');
  add(toolchain, '/rustc');
  add(shortPath(toolchain), '/rustc');
  add(root, '/mynk');
  add(shortPath(root), '/mynk');
  // Longest first so a nested directory is not swallowed by its parent.
  pairs.sort((a, b) => b[0].length - a[0].length);

  const rustc = pairs.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);

  // The home directory catches short-path spellings this script did not guess.
  const msvc = triple.includes('windows-msvc');
  const prefixes = [];
  for (const path of [...pairs.map(([from]) => from), homedir(), shortPath(homedir())]) {
    if (path && !prefixes.some((p) => p.toLowerCase() === path.toLowerCase())) prefixes.push(path);
  }
  prefixes.sort((a, b) => b.length - a.length);
  const ccAll = msvc
    ? prefixes.map((path) => `/d1trimfile:${path}${sep}`)
    : pairs.map(([from, to]) => `-ffile-prefix-map=${from}=${to}`);
  // cc-rs splits CFLAGS on whitespace, so a path with a space would become a broken flag.
  const cc = ccAll.filter((flag) => !/\s/.test(flag));
  if (cc.length < ccAll.length) {
    console.warn(
      `build-env: skipped ${ccAll.length - cc.length} C flag(s) with a space in the path.`,
    );
  }

  return { pairs, rustc, cc, triple };
}

function applyTo(env) {
  const { pairs, rustc, cc, triple } = buildFlags();
  if (!pairs.length) throw new Error('No build paths to remap; is rustc on PATH?');

  // A repeated flag changes the fingerprint and costs a full rebuild, so existing ones are kept.
  const merge = (current, split, added) => [
    ...(current || '').split(split).filter((flag) => flag && !added.includes(flag)),
    ...added,
  ];

  const encoded = env.CARGO_ENCODED_RUSTFLAGS;
  env.CARGO_ENCODED_RUSTFLAGS = merge(
    encoded ?? env.RUSTFLAGS,
    encoded ? ENCODED_SEP : /\s+/,
    rustc,
  ).join(ENCODED_SEP);
  // Cargo ignores RUSTFLAGS once the encoded form is set; dropping it keeps the two in step.
  delete env.RUSTFLAGS;

  const underscored = triple.replaceAll('-', '_');
  for (const base of ['CFLAGS', 'CXXFLAGS']) {
    // cc-rs prefers the target-specific spelling and then ignores the plain one.
    for (const name of underscored ? [base, `${base}_${underscored}`] : [base]) {
      env[name] = merge(env[name] || env[base], /\s+/, cc).join(' ');
    }
  }
  env[MARKER] = '1';
  return { pairs, rustc, cc };
}

// The executable `name` refers to, resolved through PATH (and PATHEXT on Windows).
function which(name) {
  if (name.includes('/') || name.includes('\\')) return existsSync(name) ? resolve(name) : '';
  const exts = process.platform === 'win32' ? process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD' : '';
  const candidates = exts ? exts.split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const ext of extname(name) && exts ? [''] : candidates) {
      const candidate = join(dir, name + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* next candidate */
      }
    }
  }
  return '';
}

// cmd.exe expands these inside double quotes too, so a shell run cannot quote them away.
function assertShellSafe(arg) {
  if (/[\r\n%!]/.test(arg)) throw new Error(`Argument cannot be passed through a shell: ${arg}`);
  return /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
}

// `.cmd`/`.bat` shims (npm, npx, tauri) cannot be spawned without a shell; everything else can.
function runCommand(argv) {
  const file = which(argv[0]);
  const shim = /\.(cmd|bat)$/i.test(file || argv[0]);
  if (file && !shim) return spawnSync(file, argv.slice(1), { stdio: 'inherit', shell: false });
  const command = [file || argv[0], ...argv.slice(1)].map(assertShellSafe).join(' ');
  return spawnSync(command, { stdio: 'inherit', shell: true });
}

const argv = process.argv.slice(2);
let check = [];
while (argv[0]?.startsWith('--check='))
  check = argv.shift().slice('--check='.length).split(',').filter(Boolean);

if (argv[0] === '--github-env') {
  const env = { ...process.env };
  const { cc, pairs } = applyTo(env);
  const spaced = pairs.find(([from]) => /\s/.test(from));
  if (spaced) throw new Error(`Cannot export a remapped path containing a space: ${spaced[0]}`);
  // A line-based env file cannot carry the whitespace-free encoding, hence plain RUSTFLAGS.
  const lines = [`RUSTFLAGS=${env.CARGO_ENCODED_RUSTFLAGS.split(ENCODED_SEP).join(' ')}`];
  for (const [name, value] of Object.entries(env)) {
    if (/^(CFLAGS|CXXFLAGS)/.test(name) && value !== process.env[name]) {
      lines.push(`${name}=${value}`);
    }
  }
  // A newline in a value would forge further lines in the runner's environment file.
  for (const line of lines) {
    if (/[\r\n]/.test(line)) throw new Error(`Refusing to export a multi-line value: ${line}`);
  }
  // No MARKER here: a later wrapper run must still scan the artifacts it produces.
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${lines.join('\n')}\n`);
  // Only the names: the values are the paths this script keeps out of artifacts.
  console.log(
    `Remapped ${pairs.length} build path prefixes (${cc.length} C flags) via ${lines
      .map((line) => line.slice(0, line.indexOf('=')))
      .join(', ')}.`,
  );
  process.exit(0);
}

if (!argv.length)
  throw new Error('Usage: node scripts/build-env.mjs [--check=a,b] <command> [args...]');

const nested = process.env[MARKER] === '1';
if (!nested) {
  const { pairs } = applyTo(process.env);
  const targets = [...new Set(pairs.map(([, to]) => to))].join(' ');
  console.log(`Remapping ${pairs.length} build path prefixes to ${targets}`);
  warnAboutBundling();
}

// Off Windows bundling is skipped without a message, and without the updater key it fails late;
// warn up front.
function warnAboutBundling() {
  if (argv[0] !== 'tauri' || argv[1] !== 'build' || argv.includes('--no-bundle')) return;
  if (process.platform !== 'win32') {
    console.log(
      'Note: the only configured bundle target is the Windows NSIS installer, so this build ' +
        'produces an executable but no package. Pass -- --no-bundle to skip the bundler step.',
    );
  } else if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    console.log(
      'Note: TAURI_SIGNING_PRIVATE_KEY is not set, so the NSIS step will stop for the updater ' +
        'signing key after the compile. Pass -- --no-bundle to build without packaging.',
    );
  }
}

const built = runCommand(argv);
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);

// A nested run (tauri's beforeBuildCommand) sees a half-built tree; the outer one does the check.
if (!nested && check.length) {
  const guard = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'check-artifact-paths.mjs'), ...check],
    { stdio: 'inherit' },
  );
  if (guard.status !== 0) process.exit(guard.status ?? 1);
}
