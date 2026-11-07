// Copies the public site files into dist/ for hosts that want a build step and an
// output folder (Hostinger's Node.js deploy). Nothing is compiled.
//   npm run build

import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'dist');
const privateNames = new Set(['dist', 'partials', 'tools', 'node_modules', 'README.md', 'package.json', 'package-lock.json', '.gitignore']);

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const name of readdirSync(root)) {
  if (privateNames.has(name)) continue;
  cpSync(join(root, name), join(out, name), { recursive: true });
}
console.log('built dist/');
