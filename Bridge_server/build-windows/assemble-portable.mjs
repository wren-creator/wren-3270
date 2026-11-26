#!/usr/bin/env node
// Assembles dist/Wren3270-Portable/: Wren3270.exe + public/ + seed data
// files + a generated admin-relaunch .bat + README-WINDOWS.txt +
// SHA256SUMS.txt, then zips the folder.
//
// Deliberately an ALLOWLIST, not a directory copy, for the data files:
// this project's own working tree has real personal/engagement data sitting
// in files .gitignore already calls out as "never commit" — ssh-hosts.txt,
// ftp-hosts.txt, telnet-hosts.txt, lpars.txt, scope.json, default-accounts.txt,
// pool-limits.json, macros/local/ — and a careless `cp -r` from this machine
// would ship that straight to whoever downloads the package. Only the
// *.shipped.txt / *.example seed templates and genuinely-tracked reference
// content are copied.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist', 'Wren3270-Portable');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ── exe ──────────────────────────────────────────────────────────────
const exeSrc = path.join(root, 'dist', 'Wren3270.exe');
if (!fs.existsSync(exeSrc)) {
  console.error('dist/Wren3270.exe not found — run the esbuild + pkg steps first.');
  process.exit(1);
}
fs.copyFileSync(exeSrc, path.join(outDir, 'Wren3270.exe'));

// ── public/ (static client, fully tracked, nothing personal in it) ──
// *.test.js excluded: dev-only unit tests, not client assets, and copying
// them left them sitting on disk under dist/ where `npm test`'s plain
// `node --test` (recursive discovery, no path restriction) picked them up
// as a second, duplicate copy of every public/js test — caught because the
// run's pass/fail counts suddenly changed after assembling a portable build.
fs.cpSync(path.join(root, 'public'), path.join(outDir, 'public'), {
  recursive: true,
  filter: (src) => !src.endsWith('.test.js'),
});

// ── seed data files — shipped/example templates only, never the live,
//    gitignored personal files that happen to exist on this build machine ──
const seedFiles = [
  'ssh-hosts.shipped.txt', 'ssh-hosts.txt.example',
  'ftp-hosts.shipped.txt', 'ftp-hosts.txt.example',
  'telnet-hosts.shipped.txt', 'telnet-hosts.txt.example',
  'lpars.shipped.txt', 'lpars.txt.example',
  'default-accounts.txt.example',
  'scope.json.example',
  'pool-limits.json.example',
  'macros-security.json',
];
for (const f of seedFiles) {
  const src = path.join(root, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, f));
}

// macros/shipped.json — default macros tracked in git; macros/local/ and
// macros/library/ are the user's own writable dirs, created fresh on first
// run by the app itself, never copied from this machine's.
fs.mkdirSync(path.join(outDir, 'macros'), { recursive: true });
const shippedMacros = path.join(root, 'macros', 'shipped.json');
if (fs.existsSync(shippedMacros)) {
  fs.copyFileSync(shippedMacros, path.join(outDir, 'macros', 'shipped.json'));
}

// ── admin-relaunch .bat ──────────────────────────────────────────────
// Not needed for normal use (unlike iplxec-toolkit's Windows build, this
// one bundles no raw-socket tooling that needs elevation) — kept only as
// a convenience for the rare case a target network requires it.
fs.writeFileSync(
  path.join(outDir, 'Wren3270 (Run as Administrator).bat'),
  '@echo off\r\n' +
  'powershell -Command "Start-Process -FilePath \'Wren3270.exe\' -WorkingDirectory \'%~dp0\' -Verb RunAs"\r\n'
);

// ── README-WINDOWS.txt ───────────────────────────────────────────────
const readmeSrc = path.join(__dirname, 'README-WINDOWS.md');
if (fs.existsSync(readmeSrc)) {
  fs.copyFileSync(readmeSrc, path.join(outDir, 'README-WINDOWS.txt'));
}

// ── SHA256SUMS.txt — relative paths, forward slashes, so it reads the
//    same regardless of which OS verifies it ──────────────────────────
function listFiles(dir, base = dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(listFiles(full, base));
    else out.push(full);
  }
  return out;
}
const sumLines = listFiles(outDir)
  .sort()
  .map(f => {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const rel = path.relative(outDir, f).split(path.sep).join('/');
    return `${hash}  ${rel}`;
  });
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), sumLines.join('\n') + '\n');

console.log(`Assembled ${outDir}`);

// ── zip ──────────────────────────────────────────────────────────────
const zipPath = path.join(root, 'dist', 'Wren3270-Portable.zip');
fs.rmSync(zipPath, { force: true });
execSync(`cd "${path.dirname(outDir)}" && zip -rq "${zipPath}" "${path.basename(outDir)}"`);
console.log(`Zipped ${zipPath}`);
