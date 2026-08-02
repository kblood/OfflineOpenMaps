import { expect, test } from '@playwright/test';

// This is deliberately a browser-level test: it proves the web shell opens a
// downloaded SQLite-backed Denmark pack, hands points from the MapLibre map to
// the browser router, and renders a real InternalRouter result. It does not
// rely on Electron's IPC bridge or the Node implementation.
test('downloaded Denmark web pack routes inside its open subpack', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(process.env.OPENMAPS_WEB_URL ?? 'https://dionysus.dk/openmaps/', {
    waitUntil: 'networkidle',
  });

  const packButton = page.getByRole('button', { name: /Denmark — Northwest Jutland/ });
  await expect(packButton).toBeVisible({ timeout: 30_000 });
  // National routing is an optional companion, not a disguised map pack.
  // The catalogue/UI contract must expose its separate install action before
  // any regional pack is opened.
  await expect(page.getByRole('button', { name: 'Enable Denmark-wide car routing' })).toBeVisible();
  await packButton.click();

  // Download + hash verification + sqlite-wasm opening happen before Route
  // becomes visible. This intentionally exercises the production loader.
  await expect(page.getByRole('heading', { name: 'Route' })).toBeVisible({ timeout: 120_000 });
  const canvas = page.locator('canvas.maplibregl-canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('MapLibre canvas has no bounding box');

  await page.getByRole('button', { name: /^A:/ }).click();
  await canvas.click({ position: { x: box.width * 0.47, y: box.height * 0.52 } });
  await page.getByRole('button', { name: /^B:/ }).click();
  await canvas.click({ position: { x: box.width * 0.53, y: box.height * 0.48 } });

  const findRoute = page.getByRole('button', { name: 'Find route' });
  await expect(findRoute).toBeEnabled();
  await findRoute.click();
  await expect(page.getByText('engine: internal-dijkstra')).toBeVisible({ timeout: 30_000 });
});
