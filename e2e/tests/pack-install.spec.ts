/**
 * Playwright e2e for the install / uninstall / pack-switch flow added in
 * the M4 finish. We monkey-patch dialog.showOpenDialog in the main process
 * so the test can drive "Install from folder…" deterministically — this is
 * the standard pattern with Playwright-Electron.
 *
 * What this proves:
 *   1. installFromDir wired through IPC actually copies a valid pack and
 *      makes it appear in packs.list().
 *   2. uninstall removes the pack from packs.list().
 *   3. Opening pack B after pack A releases A's SQLite file handles, so a
 *      subsequent uninstall of A succeeds (Windows file-lock regression).
 *   4. Uninstalling the currently-open pack does the close-then-delete dance
 *      cleanly without leaking handles.
 */
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { RegionManifest } from '@openmaps/core';
import { attachConsoleGate } from './_consoleGate.js';

const here = resolve(fileURLToPath(import.meta.url), '../..');
const repoRoot = resolve(here, '..');
const builderCli = resolve(repoRoot, 'packages/region-builder/dist/cli.js');
const electronMain = resolve(repoRoot, 'shells/electron/dist/main/main.js');
const osmFixture = resolve(
  repoRoot,
  'packages/region-builder/tests/fixtures/tinytown.osm',
);

// Two staging dirs:
//   sourceDir holds freshly-built source packs we'll point installFromDir at
//   packsDir is the app's "live" packs directory
let sourceDir: string;
let packsDir: string;

test.beforeAll(() => {
  if (!existsSync(builderCli) || !existsSync(electronMain)) {
    throw new Error('Builds missing. Run the build steps first.');
  }
  sourceDir = mkdtempSync(join(tmpdir(), 'openmaps-e2e-src-'));
  packsDir = mkdtempSync(join(tmpdir(), 'openmaps-e2e-dst-'));
  mkdirSync(packsDir, { recursive: true });
  // Build two real packs into sourceDir, but don't pre-stage them in packsDir
  // — install tests need to drive the install path themselves.
  execFileSync('node', [builderCli, 'build-synthetic', '--id', 'fakeland', '--out', sourceDir], {
    stdio: 'pipe',
  });
  execFileSync(
    'node',
    [
      builderCli,
      'build-osm',
      '--in',
      osmFixture,
      '--id',
      'tinytown',
      '--name',
      'Tinytown',
      '--country',
      'AD',
      '--out',
      sourceDir,
    ],
    { stdio: 'pipe' },
  );
});

test.afterAll(() => {
  if (sourceDir) rmSync(sourceDir, { recursive: true, force: true });
  if (packsDir) rmSync(packsDir, { recursive: true, force: true });
});

async function launchWithMockedDialog(srcPath: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [resolve(repoRoot, 'shells/electron')],
    env: { ...process.env, OPENMAPS_PACKS_DIR: packsDir },
  });
  // Replace dialog.showOpenDialog in the MAIN process so the renderer's
  // installFromDir() call resolves to our pre-staged source dir instead of
  // popping a real OS picker.
  await app.evaluate(({ dialog }, p) => {
    // @ts-expect-error reassigning a method for test purposes
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    // @ts-expect-error same
    dialog.showOpenDialogSync = () => [p];
  }, srcPath);
  return app;
}

test('install from a folder makes the pack appear in packs.list', async () => {
  // Start with an empty packsDir.
  rmSync(packsDir, { recursive: true, force: true });
  mkdirSync(packsDir, { recursive: true });

  const app = await launchWithMockedDialog(join(sourceDir, 'fakeland'));
  const gate = await attachConsoleGate(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof (window as unknown as { openmaps?: unknown }).openmaps === 'object');

    const before = await win.evaluate(() => window.openmaps.packs.list());
    expect(before).toEqual([]);

    const result = await win.evaluate(() => window.openmaps.packs.installFromDir());
    expect(result.installed).toBe(true);
    if (result.installed) {
      expect((result.manifest as RegionManifest).id).toBe('fakeland');
    }

    const after = await win.evaluate(() => window.openmaps.packs.list());
    expect(after.map((m) => m.id)).toContain('fakeland');
    gate.assertNoConsoleErrors();
  } finally {
    await app.close();
  }
});

test('uninstall removes the pack', async () => {
  // Make sure fakeland is installed first (previous test leaves it that way,
  // but this test should be order-independent).
  rmSync(packsDir, { recursive: true, force: true });
  mkdirSync(packsDir, { recursive: true });
  cpSync(join(sourceDir, 'fakeland'), join(packsDir, 'fakeland'), { recursive: true });

  const app = await electron.launch({
    args: [resolve(repoRoot, 'shells/electron')],
    env: { ...process.env, OPENMAPS_PACKS_DIR: packsDir },
  });
  const gate = await attachConsoleGate(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof (window as unknown as { openmaps?: unknown }).openmaps === 'object');

    const before = await win.evaluate(() => window.openmaps.packs.list());
    expect(before.map((m) => m.id)).toContain('fakeland');

    await win.evaluate(() => window.openmaps.packs.uninstall('fakeland'));

    const after = await win.evaluate(() => window.openmaps.packs.list());
    expect(after.map((m) => m.id)).not.toContain('fakeland');
    gate.assertNoConsoleErrors();
  } finally {
    await app.close();
  }
});

test('uninstalling the currently-open pack closes its file handles cleanly', async () => {
  // This is the Windows file-lock regression: rm() of an open SQLite file
  // fails on Windows because the handle is held. The IPC handler must close
  // the pack before uninstalling.
  rmSync(packsDir, { recursive: true, force: true });
  mkdirSync(packsDir, { recursive: true });
  cpSync(join(sourceDir, 'fakeland'), join(packsDir, 'fakeland'), { recursive: true });

  const app = await electron.launch({
    args: [resolve(repoRoot, 'shells/electron')],
    env: { ...process.env, OPENMAPS_PACKS_DIR: packsDir },
  });
  const gate = await attachConsoleGate(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof (window as unknown as { openmaps?: unknown }).openmaps === 'object');

    await win.evaluate(() => window.openmaps.packs.open('fakeland'));
    // Touch a query so SQLite has actually opened the file.
    await win.evaluate(() => window.openmaps.geocode.search('Fake'));

    // Now uninstall while the pack is open. Should not throw.
    await win.evaluate(() => window.openmaps.packs.uninstall('fakeland'));

    const after = await win.evaluate(() => window.openmaps.packs.list());
    expect(after.map((m) => m.id)).not.toContain('fakeland');

    const current = await win.evaluate(() => window.openmaps.packs.current());
    expect(current).toBeNull();
    gate.assertNoConsoleErrors();
  } finally {
    await app.close();
  }
});

test('switching from pack A to pack B releases A and B works fully', async () => {
  // Pre-stage both packs.
  rmSync(packsDir, { recursive: true, force: true });
  mkdirSync(packsDir, { recursive: true });
  cpSync(join(sourceDir, 'fakeland'), join(packsDir, 'fakeland'), { recursive: true });
  cpSync(join(sourceDir, 'tinytown'), join(packsDir, 'tinytown'), { recursive: true });

  const app = await electron.launch({
    args: [resolve(repoRoot, 'shells/electron')],
    env: { ...process.env, OPENMAPS_PACKS_DIR: packsDir },
  });
  const gate = await attachConsoleGate(app);
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof (window as unknown as { openmaps?: unknown }).openmaps === 'object');

    // Open A, query it.
    await win.evaluate(() => window.openmaps.packs.open('fakeland'));
    const fakeResults = await win.evaluate(() => window.openmaps.geocode.search('Fake'));
    expect(fakeResults.some((r) => r.displayName === 'Faketown')).toBe(true);

    // Switch to B.
    const opened = await win.evaluate(() => window.openmaps.packs.open('tinytown'));
    expect((opened as RegionManifest).id).toBe('tinytown');

    // Query B — search hits Tinytown, not Faketown.
    const tinyResults = await win.evaluate(() => window.openmaps.geocode.search('Tiny'));
    expect(tinyResults.some((r) => r.displayName === 'Tinytown')).toBe(true);
    const stillFakeland = await win.evaluate(() => window.openmaps.geocode.search('Faketown'));
    expect(stillFakeland.some((r) => r.displayName === 'Faketown')).toBe(false);

    // Now uninstall A while B is the open pack — A's handles were closed
    // when we switched, so this must work on Windows too.
    await win.evaluate(() => window.openmaps.packs.uninstall('fakeland'));
    const after = await win.evaluate(() => window.openmaps.packs.list());
    expect(after.map((m) => m.id)).toEqual(['tinytown']);
    gate.assertNoConsoleErrors();
  } finally {
    await app.close();
  }
});
