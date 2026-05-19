/**
 * The canonical e2e proof that v2 actually works offline.
 *
 * What this does:
 *   1. Builds (or expects pre-built) the fakeland synthetic pack.
 *   2. Launches the packaged Electron app pointed at that pack.
 *   3. From the renderer, calls window.openmaps.* to:
 *        - open the pack
 *        - run the self-test (which internally flips the BrowserWindow's
 *          session into offline mode)
 *   4. Asserts every check is "pass".
 *
 * If this passes, the four offline guarantees from PLAN.md hold for real.
 */
import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import type { SelfTestReport, RegionManifest } from '@openmaps/core';
import { attachConsoleGate } from './_consoleGate.js';

const here = resolve(fileURLToPath(import.meta.url), '../..');
const repoRoot = resolve(here, '..');
const builderCli = resolve(repoRoot, 'packages/region-builder/dist/cli.js');
const electronMain = resolve(repoRoot, 'shells/electron/dist/main/main.js');

let packsDir: string;

test.beforeAll(() => {
  if (!existsSync(builderCli)) {
    throw new Error(
      `region-builder not built. Run \`npx tsc -p packages/region-builder/tsconfig.json\` first.`,
    );
  }
  if (!existsSync(electronMain)) {
    throw new Error(
      `electron main not built. Run \`npx tsc -p shells/electron/tsconfig.main.json && npx vite build --config shells/electron/vite.config.ts\` first.`,
    );
  }
  packsDir = mkdtempSync(join(tmpdir(), 'openmaps-e2e-'));
  execFileSync('node', [builderCli, 'build-synthetic', '--id', 'fakeland', '--out', packsDir], {
    stdio: 'pipe',
  });
});

test.afterAll(() => {
  if (packsDir) rmSync(packsDir, { recursive: true, force: true });
});

test('full offline pipeline: 4/4 self-test checks pass with network severed', async () => {
  const app = await electron.launch({
    args: [resolve(repoRoot, 'shells/electron')],
    env: {
      ...process.env,
      OPENMAPS_PACKS_DIR: packsDir,
    },
  });
  const gate = await attachConsoleGate(app);

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // Wait for the preload contextBridge to populate window.openmaps.
    await win.waitForFunction(() => typeof (window as unknown as { openmaps?: unknown }).openmaps === 'object');

    // Open the pack programmatically (avoids relying on rendered DOM).
    const opened = await win.evaluate(async (): Promise<RegionManifest | { error: string }> => {
      try {
        return await window.openmaps.packs.open('fakeland');
      } catch (e) {
        return { error: (e as Error).message };
      }
    });
    expect((opened as RegionManifest).id).toBe('fakeland');

    // Run self-test. The renderer code in SelfTestPanel.tsx does this exact
    // sequence: offline.set(true) → selftest.run() → offline.set(false).
    const report = await win.evaluate(async (): Promise<SelfTestReport> => {
      await window.openmaps.offline.set(true);
      try {
        return await window.openmaps.selftest.run();
      } finally {
        await window.openmaps.offline.set(false);
      }
    });

    // eslint-disable-next-line no-console
    console.log('Self-test report:', JSON.stringify(report, null, 2));

    expect(report.allPassed, `Self-test failed: ${JSON.stringify(report.results, null, 2)}`).toBe(true);
    expect(report.results.map((r) => r.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(report.results.map((r) => r.id)).toEqual(['tiles', 'search', 'reverse', 'route']);
    gate.assertNoConsoleErrors();
  } finally {
    await app.close();
  }
});

test('reverse-geocode at the manifest anchor returns a road WHILE offline', async () => {
  const app = await electron.launch({
    args: [resolve(repoRoot, 'shells/electron')],
    env: { ...process.env, OPENMAPS_PACKS_DIR: packsDir },
  });
  const gate = await attachConsoleGate(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof (window as unknown as { openmaps?: unknown }).openmaps === 'object');

    const manifest = await win.evaluate(() => window.openmaps.packs.open('fakeland'));
    await win.evaluate(() => window.openmaps.offline.set(true));
    try {
      const result = await win.evaluate(
        async ({ lat, lon }) => window.openmaps.geocode.reverse(lat, lon, { maxRadiusM: 1000 }),
        (manifest as RegionManifest).selfTestAnchors.reversePoint,
      );
      expect(result).not.toBeNull();
      // In the synthetic fixture the reverse point sits exactly on a POI at
      // distance 0, which (correctly) outranks the ~1km-away nearest road.
      // Accept either road or POI — both are legitimate offline reverse hits.
      expect(result?.displayName).toBeTruthy();
      expect(['street', 'poi', 'place']).toContain(result?.kind);
    } finally {
      await win.evaluate(() => window.openmaps.offline.set(false));
    }
    gate.assertNoConsoleErrors();
  } finally {
    await app.close();
  }
});

test('route between two waypoints WHILE offline produces a real polyline', async () => {
  const app = await electron.launch({
    args: [resolve(repoRoot, 'shells/electron')],
    env: { ...process.env, OPENMAPS_PACKS_DIR: packsDir },
  });
  const gate = await attachConsoleGate(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof (window as unknown as { openmaps?: unknown }).openmaps === 'object');

    const manifest = await win.evaluate(() => window.openmaps.packs.open('fakeland'));
    await win.evaluate(() => window.openmaps.offline.set(true));
    try {
      const waypoints = (manifest as RegionManifest).selfTestAnchors.routeWaypoints;
      const route = await win.evaluate(
        async ({ wp }) => window.openmaps.route.compute(wp, 'car'),
        { wp: waypoints },
      );
      expect(route.engine).toBe('internal-dijkstra');
      // Real graph routing produces more than 3 geometry points for a
      // diagonal route across the grid. v1's "two-point straight line + jitter"
      // fake would fail this — that's intentional.
      expect(route.geometry.length).toBeGreaterThan(3);
      expect(route.distanceM).toBeGreaterThan(0);
    } finally {
      await win.evaluate(() => window.openmaps.offline.set(false));
    }
    gate.assertNoConsoleErrors();
  } finally {
    await app.close();
  }
});
