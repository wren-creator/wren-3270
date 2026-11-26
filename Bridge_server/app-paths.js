// Single place every other file asks "where does the app's own data live
// on disk?" instead of each computing __dirname independently. That matters
// because __dirname (via import.meta.url) resolves correctly under plain
// `node server.js` and inside the Docker image, but under a pkg-packaged
// Windows .exe it resolves into pkg's virtual /snapshot/... filesystem —
// fine for reading the bundled source, wrong (and unwritable) for real
// data files like lpars.txt or the sibling public/ folder.
//
// getAppRoot() picks the right root for whichever of the three contexts
// is actually running:
//   - BRIDGE_APP_ROOT env var, if set — explicit override, useful for
//     tests/CI or an unusual deployment layout.
//   - process.pkg (set by @yao-pkg/pkg at runtime) — the packaged exe's
//     own folder, so data files and public/ resolve as siblings of the
//     .exe, the way the portable Windows build is laid out.
//   - otherwise — the existing __dirname-based project root, unchanged
//     for plain `node server.js`, Docker, and OpenShift.
import path from 'path';
import { fileURLToPath } from 'url';

// Computed lazily, inside the function, not at module-load time: once
// esbuild bundles this file to CJS (see build-windows/esbuild.config.mjs),
// `import.meta.url` is empty and fileURLToPath(undefined) throws — this
// branch is dead in that context anyway (the pkg-packaged exe always hits
// the process.pkg branch below first), but a module-scope throw happens on
// load regardless of which branch would actually be taken, before
// BRIDGE_APP_ROOT or process.pkg ever get checked.
export function getAppRoot() {
  if (process.env.BRIDGE_APP_ROOT) return process.env.BRIDGE_APP_ROOT;
  if (process.pkg) return path.dirname(process.execPath);
  return path.dirname(fileURLToPath(import.meta.url));
}
