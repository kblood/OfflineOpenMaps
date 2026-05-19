#!/usr/bin/env node
/**
 * Manual Windows packager for the Electron shell.
 *
 * Why not electron-builder? It expects each Electron app to be its own
 * standalone package and runs `npm install --production` in the appDir,
 * which fights npm workspaces (the @openmaps/* deps live in the root
 * node_modules as symlinks, not in shells/electron/node_modules).
 *
 * Why not electron-packager? It works fine but the workflow is similar
 * enough that a tiny script is clearer and easier to debug than wedging
 * around another tool's expectations.
 *
 * What this does, in order:
 *   1. Copy node_modules/electron/dist  -> release/OpenMaps-v2-win/
 *   2. Rename electron.exe              -> OpenMaps-v2.exe
 *   3. Stage the app at release/.../resources/app/ as a plain folder
 *      (no asar) with:
 *        - dist/main/, dist/renderer/  (from shells/electron/dist)
 *        - package.json                (with `main` pointing into dist)
 *        - node_modules/               (dereferenced — symlinks followed)
 *   4. Copy packs/aalborg -> resources/packs/aalborg
 *      so seedBundledPacks() can install it on first launch.
 *
 * The result is a folder you can zip and ship, or run in place by
 * double-clicking OpenMaps-v2.exe.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync, lstatSync, realpathSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const shellDir = resolve(repoRoot, 'shells/electron');
const electronDist = resolve(repoRoot, 'node_modules/electron/dist');
const outRoot = resolve(repoRoot, 'release');
const outDir = resolve(outRoot, 'OpenMaps-v2-win');
const resourcesDir = resolve(outDir, 'resources');
const appDir = resolve(resourcesDir, 'app');
const exeName = 'OpenMaps-v2.exe';

function log(msg) {
  process.stdout.write(`[package-win] ${msg}\n`);
}

// 1. Clean output and copy Electron runtime.
log(`output: ${outDir}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
if (!existsSync(electronDist)) {
  process.stderr.write(`[package-win] electron not installed at ${electronDist}. Run npm install at repo root.\n`);
  process.exit(1);
}
log('copying Electron runtime…');
cpSync(electronDist, outDir, { recursive: true, dereference: true });

// 2. Rename electron.exe to a product-branded name.
const srcExe = resolve(outDir, 'electron.exe');
const dstExe = resolve(outDir, exeName);
if (existsSync(srcExe)) {
  renameSync(srcExe, dstExe);
  log(`renamed electron.exe -> ${exeName}`);
}

// 3. Stage the app (shell dist + a slimmed package.json + node_modules).
log('staging app folder…');
mkdirSync(appDir, { recursive: true });

// 3a. The compiled shell.
cpSync(resolve(shellDir, 'dist'), resolve(appDir, 'dist'), { recursive: true });

// 3b. A trimmed package.json. Electron reads `main` to know where to start.
const fullPkg = JSON.parse(readFileSync(resolve(shellDir, 'package.json'), 'utf8'));
const trimmed = {
  name: fullPkg.name,
  version: fullPkg.version,
  type: fullPkg.type,
  main: fullPkg.main,
  description: fullPkg.description ?? 'OpenMaps v2',
  author: fullPkg.author ?? 'OpenMaps v2',
};
writeFileSync(resolve(appDir, 'package.json'), JSON.stringify(trimmed, null, 2));

// 3c. node_modules — only the runtime deps. We copy from root node_modules
//     (where workspaces hoist things) and dereference symlinks so the
//     @openmaps/* packages get their actual contents inlined.
const runtimeDeps = Object.keys(fullPkg.dependencies ?? {});
const rootNm = resolve(repoRoot, 'node_modules');
const appNm = resolve(appDir, 'node_modules');
mkdirSync(appNm, { recursive: true });

// Recursive copier that dereferences symlinks (cpSync's dereference:true does
// this) AND that walks each copied package's own dependencies so we get the
// transitive closure. This is the trickiest bit — we can't just copy
// node_modules/* because that's 400+ MB; we want only deps reachable from
// the shell's dependencies.
const copied = new Set();
function copyPackage(name) {
  if (copied.has(name)) return;
  copied.add(name);
  const src = resolve(rootNm, name);
  if (!existsSync(src)) {
    log(`  WARN: ${name} not found at ${src} — skipping`);
    return;
  }
  const realSrc = realpathSync(src);
  const dst = resolve(appNm, name);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(realSrc, dst, { recursive: true, dereference: true });
  // Recurse into this package's own deps.
  const pkgJsonPath = resolve(realSrc, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        copyPackage(dep);
      }
      for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
        // Optional deps may be missing; copyPackage will warn and skip.
        copyPackage(dep);
      }
    } catch (err) {
      log(`  WARN: cannot parse ${pkgJsonPath}: ${err.message}`);
    }
  }
}
log(`copying runtime deps (transitive closure)…`);
for (const dep of runtimeDeps) copyPackage(dep);
log(`  -> ${copied.size} packages copied`);

// 4. Bundle the Aalborg pack into resources/packs/ (main.ts's seedBundledPacks
//    looks here on first launch).
const aalborgSrc = resolve(repoRoot, 'packs/aalborg');
const aalborgDst = resolve(resourcesDir, 'packs/aalborg');
if (existsSync(aalborgSrc)) {
  log('bundling Aalborg pack…');
  mkdirSync(dirname(aalborgDst), { recursive: true });
  cpSync(aalborgSrc, aalborgDst, { recursive: true });
} else {
  log(`WARN: no Aalborg pack at ${aalborgSrc} — packaging without a default pack`);
}

// 5. Print final size summary.
function sizeOf(p) {
  if (!existsSync(p)) return 0;
  const s = lstatSync(p);
  if (s.isFile()) return s.size;
  if (!s.isDirectory()) return 0;
  let total = 0;
  for (const entry of readdirSync(p)) total += sizeOf(resolve(p, entry));
  return total;
}
const totalMB = (sizeOf(outDir) / 1e6).toFixed(1);
log(`done. Run: ${dstExe}`);
log(`folder size: ${totalMB} MB`);
