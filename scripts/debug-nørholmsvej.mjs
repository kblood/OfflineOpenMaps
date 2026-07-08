// Headless reproduction of the user's reported bug: search "Nørholmsvej 59"
// on the live web shell, observe the resulting marker + parcel coordinates.
// We don't depend on a built-in test harness — just drive the page with
// Playwright and dump the marker's lat/lon plus the map center.
import { chromium } from 'playwright';

const URL = 'https://dionysus.dk/openmaps/';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => process.stdout.write(`[console.${m.type()}] ${m.text()}\n`));
page.on('pageerror', (e) => process.stdout.write(`[pageerror] ${e.message}\n`));

process.stdout.write(`Loading ${URL}\n`);
await page.goto(URL, { waitUntil: 'networkidle' });

// Download the Aalborg pack
process.stdout.write('Clicking Aalborg pack button…\n');
const packButton = page.locator('button:has-text("Aalborg")').first();
await packButton.click();

// Wait for the map (the pack download is reasonably slow)
process.stdout.write('Waiting for map to load…\n');
await page.waitForFunction(() => {
  // MapLibre adds a canvas once initialized
  return Boolean(document.querySelector('.maplibregl-canvas'));
}, { timeout: 120_000 });
// Extra time for tiles to render
await page.waitForTimeout(3000);

process.stdout.write('Searching "Nørholmsvej 59"…\n');
const searchInput = page.locator('input[placeholder*="Place name"]');
await searchInput.fill('Nørholmsvej 59');
await page.waitForTimeout(1500); // debounced search

// Capture the search result rows
const results = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.result-list li'));
  return items.map((li) => ({
    text: li.textContent ?? '',
    rect: li.getBoundingClientRect().toJSON(),
  }));
});
process.stdout.write(`Found ${results.length} result(s): ${JSON.stringify(results.map((r) => r.text))}\n`);

if (results.length === 0) {
  process.stdout.write('No search results — bailing.\n');
  await browser.close();
  process.exit(1);
}

// Click the first one
await page.locator('.result-list li').first().click();
await page.waitForTimeout(1500);

// Inspect the marker + map state
const state = await page.evaluate(() => {
  const markers = Array.from(document.querySelectorAll('.maplibregl-marker'));
  const markerInfo = markers.map((m) => {
    const t = (m).style.transform ?? '';
    return { transform: t, rect: m.getBoundingClientRect().toJSON() };
  });
  // Map center / zoom isn't easily accessible without a global reference,
  // so we infer it from MapLibre's map div bounding box overlap with the
  // marker — and read the URL hash if present.
  return {
    markerCount: markers.length,
    markers: markerInfo,
    url: location.href,
  };
});
process.stdout.write(`Final state: ${JSON.stringify(state, null, 2)}\n`);

// Screenshot for visual inspection
await page.screenshot({ path: 'packs/debug-nørholmsvej.png', fullPage: false });
process.stdout.write('Screenshot → packs/debug-nørholmsvej.png\n');

await browser.close();
