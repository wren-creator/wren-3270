#!/usr/bin/env node
// Bundles server.js + its whole ESM import graph into one CJS file, since
// both @yao-pkg/pkg and Node's own Single Executable Applications feature
// want a single CJS entry point, not a "type": "module" tree of files.
//
// ssh2's optional native crypto accelerator (sshcrypto.node, built from
// cpu-features/nan at npm-install time) is marked external: esbuild can't
// bundle a compiled .node binary as JS, and doesn't need to — ssh2's own
// require() for it is already wrapped in try/catch (lib/protocol/crypto.js),
// which is what makes it fail open to the pure-JS crypto path when the
// binding isn't present. That's exactly the Windows build's situation,
// since package.windows.json never installs cpu-features/nan at all.
import { build } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

await build({
  entryPoints: [path.join(root, 'server.js')],
  outfile: path.join(root, 'dist', 'bundle.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['*.node', 'cpu-features', 'nan'],
  logLevel: 'info',
});
