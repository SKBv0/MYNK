// Makes a fresh clone ready for cargo: tauri-build wants a frontend dist folder and the
// mynk-mcp sidecar file on every command, long before either is built.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

if (existsSync(dist)) {
  console.log(`dist already exists: ${dist}`);
} else {
  mkdirSync(dist, { recursive: true });
  console.log(`empty dist created: ${dist} (run "npm run build" for the real one)`);
}

execFileSync(process.execPath, [join(root, 'scripts', 'copy-mcp-sidecar.mjs'), '--ensure'], {
  stdio: 'inherit',
});
