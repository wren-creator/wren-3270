#!/usr/bin/env node
// Copies xterm.js/xterm.css/addon-fit.js out of node_modules into
// public/vendor/xterm/, the same self-hosted-instead-of-CDN precedent
// public/fonts/ already set for the IBM Plex fonts. Run this after bumping
// the @xterm/xterm or @xterm/addon-fit devDependency version.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const destDir = path.join(root, 'public', 'vendor', 'xterm');

const files = [
  { from: path.join(root, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), to: 'xterm.js' },
  { from: path.join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), to: 'xterm.css' },
  { from: path.join(root, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'), to: 'addon-fit.js' },
];

fs.mkdirSync(destDir, { recursive: true });
for (const { from, to } of files) {
  fs.copyFileSync(from, path.join(destDir, to));
  console.log(`vendored ${to}`);
}
