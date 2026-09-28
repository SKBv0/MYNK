// Regenerates THIRD-PARTY-LICENSES.md from the npm production closure and the Rust
// normal-dependency closure. Needs npm and cargo on PATH; installs nothing.
// Usage: npm run licenses [-- --check]

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'THIRD-PARTY-LICENSES.md');
const checkOnly = process.argv.includes('--check');

// SPDX identifiers that allow redistribution with no obligation beyond attribution.
const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'OFL-1.1',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'Zlib',
]);

// File-level copyleft: fine to ship unmodified, as long as the source stays available. The
// crates under it are listed with their repository links in THIRD-PARTY-LICENSES.md.
const ALLOWED = new Set([...PERMISSIVE, 'MPL-2.0']);

// SPDX precedence: AND binds tighter than OR. "MIT OR GPL-3.0" passes because one side does;
// "MIT AND GPL-3.0" fails because every AND term must pass.
function isPermissive(expression) {
  if (!expression) return false;
  // Many crates predate SPDX and write the choice as "MIT/Apache-2.0".
  const tokens = expression.replaceAll('/', ' OR ').match(/[()]|[^\s()]+/g) ?? [];
  let pos = 0;
  const keyword = () => tokens[pos]?.toUpperCase();
  const license = () => {
    if (tokens[pos] === '(') {
      pos += 1;
      const ok = anyOf();
      if (tokens[pos] !== ')') throw new Error('unbalanced parentheses');
      pos += 1;
      return ok;
    }
    const id = tokens[pos];
    if (!id || id === ')' || ['AND', 'OR', 'WITH'].includes(id.toUpperCase())) {
      throw new Error('expected a license');
    }
    pos += 1;
    // "Apache-2.0 WITH LLVM-exception" is judged by the license, not the exception.
    if (keyword() === 'WITH') pos += 2;
    return ALLOWED.has(id);
  };
  const allOf = () => {
    let ok = license();
    while (keyword() === 'AND') {
      pos += 1;
      ok = license() && ok;
    }
    return ok;
  };
  const anyOf = () => {
    let ok = allOf();
    while (keyword() === 'OR') {
      pos += 1;
      ok = allOf() || ok;
    }
    return ok;
  };
  try {
    const ok = anyOf();
    return ok && pos === tokens.length;
  } catch {
    return false;
  }
}

const spawnOptions = { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };

function capture(file, args) {
  return execFileSync(file, args, spawnOptions);
}

// npm exits non-zero over an unmet optional peer, but still prints the requested tree.
function npmTree() {
  // A shell, because `npm` is a .cmd shim on Windows that Node refuses to spawn directly.
  try {
    return JSON.parse(execSync('npm ls --omit=dev --all --json', spawnOptions));
  } catch (error) {
    if (!error.stdout) throw error;
    return JSON.parse(error.stdout);
  }
}

function readManifest(dir) {
  const path = join(dir, 'package.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function repositoryUrl(manifest) {
  const raw = manifest?.repository;
  const url = typeof raw === 'string' ? raw : raw?.url;
  if (!url) return manifest?.homepage ?? '';
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '');
}

function npmPackages() {
  const found = new Map();
  const visit = (node, chain) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      // An unmet optional peer has no version and nothing on disk; it ships with nothing.
      if (!child.version) continue;
      const dir = chain
        .map((base) => join(base, 'node_modules', ...name.split('/')))
        .find((candidate) => existsSync(candidate));
      const manifest = dir ? readManifest(dir) : null;
      const key = `${name}@${child.version}`;
      if (!found.has(key)) {
        found.set(key, {
          name,
          version: child.version,
          license: manifest?.license ?? manifest?.licenses?.[0]?.type ?? '',
          repository: repositoryUrl(manifest) || `https://www.npmjs.com/package/${name}`,
        });
      }
      visit(child, dir ? [dir, ...chain] : chain);
    }
  };
  visit(npmTree(), [root]);
  return [...found.values()];
}

function cargoPackages() {
  const metadata = JSON.parse(
    capture('cargo', [
      'metadata',
      '--format-version',
      '1',
      // The only shipped target; the list must not depend on the machine that generates it.
      '--filter-platform',
      'x86_64-pc-windows-msvc',
      '--manifest-path',
      join(root, 'src-tauri', 'Cargo.toml'),
    ]),
  );
  const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const rootId = metadata.resolve.root;
  if (!rootId) throw new Error('cargo metadata reported no root package.');

  const reached = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.pop();
    for (const dep of nodes.get(id)?.deps ?? []) {
      // `kind: null` is a normal dependency; build scripts and dev-dependencies are not shipped.
      if (!dep.dep_kinds.some((entry) => entry.kind === null)) continue;
      if (reached.has(dep.pkg)) continue;
      reached.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }

  return [...reached].map((id) => {
    const pkg = byId.get(id);
    return {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : ''),
      repository: pkg.repository || `https://crates.io/crates/${pkg.name}`,
    };
  });
}

function table(packages) {
  const rows = packages
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'))
    .map(
      (pkg) =>
        `| \`${pkg.name}\` | ${pkg.version} | ${pkg.license || '**unknown**'} | ${pkg.repository} |`,
    );
  return ['| Package | Version | License | Source |', '|---|---|---|---|', ...rows].join('\n');
}

const npmList = npmPackages();
const cargoList = cargoPackages();
const flagged = [...npmList, ...cargoList].filter((pkg) => !isPermissive(pkg.license));

const document = `# Third-party licenses

Generated by \`npm run licenses\`; edit that script, not this file.

MYNK is MIT licensed ([LICENSE](LICENSE)). Fonts and their license text are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Below are the npm packages and Rust crates the app
is built from; build-only tools are not listed.

## npm packages (${npmList.length})

${table(npmList)}

## Rust crates (${cargoList.length})

${table(cargoList)}
`;

if (flagged.length) {
  console.warn(`
${flagged.length} package(s) without an allowed license:`);
  for (const pkg of flagged) console.warn(`  ${pkg.name} ${pkg.version}: ${pkg.license || '?'}`);
}

if (checkOnly) {
  const current = existsSync(output) ? readFileSync(output, 'utf8') : '';
  if (current !== document) {
    console.error(`${output} is out of date. Run: npm run licenses`);
    process.exit(1);
  }
  if (flagged.length) process.exit(1);
  console.log(`${output} is up to date.`);
} else {
  writeFileSync(output, document);
  console.log(`Wrote ${output}: ${npmList.length} npm packages, ${cargoList.length} Rust crates.`);
}
