// Puts the `mynk-mcp` binary where Tauri's `externalBin` expects it. `--ensure` drops a
// stand-in so tauri-build's check doesn't fail `cargo check`/`clippy`/`test` before the sidecar
// is built; the plain run then copies the real release binary over it.

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostTriple } from './lib/toolchain.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binaryName = 'mynk-mcp';
const ensureOnly = process.argv.includes('--ensure');

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const suffix = triple.includes('windows') ? '.exe' : '';
const targetDir = join(root, 'src-tauri', 'binaries');
const sidecar = join(targetDir, `${binaryName}-${triple}${suffix}`);
const built = ['release', 'debug'].map((profile) =>
  join(root, 'src-tauri', 'target', profile, `${binaryName}${suffix}`),
);

mkdirSync(targetDir, { recursive: true });

if (ensureOnly) {
  // An empty file is a placeholder; a built binary replaces it.
  const placeholder = existsSync(sidecar) && statSync(sidecar).size === 0;
  const source = built.find((candidate) => existsSync(candidate) && statSync(candidate).size > 0);
  if (existsSync(sidecar) && !(placeholder && source)) {
    console.log(`${binaryName} sidecar already in place: ${sidecar}`);
  } else if (source) {
    // A real binary keeps working when a cargo build script copies this file over the target one.
    copyFileSync(source, sidecar);
    console.log(`${binaryName} sidecar taken from ${source}`);
  } else {
    closeSync(openSync(sidecar, 'w'));
    console.log(`${binaryName} placeholder created: ${sidecar} (run "npm run build:mcp")`);
  }
} else {
  const source = built[0];
  if (!existsSync(source)) {
    throw new Error(
      `${source} does not exist. Build it first: cargo build --release --manifest-path src-tauri/Cargo.toml --bin ${binaryName}`,
    );
  }
  copyFileSync(source, sidecar);
  console.log(`${binaryName} sidecar ready: ${sidecar}`);
}
