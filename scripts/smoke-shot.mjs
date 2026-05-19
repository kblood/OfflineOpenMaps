#!/usr/bin/env node
/**
 * Visual smoke test for the packaged OpenMaps-v2.exe.
 *
 * Why this exists: shipping the .exe without ever looking at the running
 * window is how the "gray map" bug ([conversation 55438edc] mid-2026)
 * snuck through three layers of green automated tests. This script is
 * the cheapest forcing function — it launches the .exe, waits for the
 * map's `style.load` event, asserts the renderer logged zero console
 * errors, and saves a screenshot next to the .exe. A "passing" build
 * now always comes with visual proof.
 *
 * Usage:
 *   node scripts/smoke-shot.mjs
 *
 * Exit code 0 = launch succeeded, style loaded, screenshot saved,
 *               no console errors.
 * Non-zero  = something went wrong; details printed to stderr and
 *               (when possible) screenshot still saved.
 */
import { _electron as electron } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const exePath = resolve(repoRoot, 'release/OpenMaps-v2-win/OpenMaps-v2.exe');
const shotPath = resolve(repoRoot, 'release/OpenMaps-v2-win/smoke-shot.png');

function log(msg) {
  process.stdout.write(`[smoke] ${msg}\n`);
}

if (!existsSync(exePath)) {
  process.stderr.write(`[smoke] ${exePath} not found. Run \`npm run dist:portable -w @openmaps/electron-shell\` first.\n`);
  process.exit(2);
}

const errors = [];
const KNOWN_NOISE = [
  /GPU process exited unexpectedly.*exit_code=143/,
  /Network service crashed or was terminated/,
];

let app;
let exitCode = 0;

try {
  log(`launching ${exePath}`);
  app = await electron.launch({ executablePath: exePath, args: [], timeout: 30_000 });

  const win = await app.firstWindow({ timeout: 15_000 });
  win.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (KNOWN_NOISE.some((r) => r.test(text))) return;
    errors.push(text);
  });
  win.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await win.waitForLoadState('domcontentloaded');
  log('window loaded, waiting for window.openmaps bridge…');
  await win.waitForFunction(() => typeof window.openmaps === 'object', undefined, {
    timeout: 15_000,
  });

  // Wait for the auto-opened pack and the MapLibre instance to finish loading
  // its style. We probe maplibregl by looking for a canvas inside the .map
  // container; once the canvas exists and has been drawn to, the style has
  // loaded successfully.
  log('waiting for MapLibre canvas to appear…');
  await win.waitForFunction(
    () => {
      const c = document.querySelector('.map canvas');
      return c instanceof HTMLCanvasElement && c.width > 0 && c.height > 0;
    },
    undefined,
    { timeout: 20_000 },
  );

  // Brief settle so the first batch of tiles render before we screenshot.
  await new Promise((r) => setTimeout(r, 1500));

  log(`saving screenshot to ${shotPath}`);
  mkdirSync(dirname(shotPath), { recursive: true });
  const bytes = await win.screenshot({ fullPage: false });
  writeFileSync(shotPath, bytes);

  if (errors.length > 0) {
    process.stderr.write(
      `[smoke] FAIL: renderer logged ${errors.length} console.error(s):\n` +
        errors.map((e, i) => `  [${i}] ${e}`).join('\n') +
        '\n',
    );
    exitCode = 1;
  } else {
    log('OK — no console errors, screenshot saved.');
  }
} catch (err) {
  process.stderr.write(`[smoke] FAIL: ${err instanceof Error ? err.stack : String(err)}\n`);
  exitCode = 1;
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      // best-effort
    }
  }
}

process.exit(exitCode);
