// Verifies the mobile layout on dionysus.dk. Loads in a phone-sized
// viewport, opens the sidebar, picks a search result, then captures a few
// screenshots so we can eyeball the new drawer + roomy tap targets.
import { chromium, devices } from 'playwright';

const URL = 'https://dionysus.dk/openmaps/';
const SHOTS = 'packs';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  ...devices['Pixel 7'],
});
const page = await ctx.newPage();
page.on('console', (m) => process.stdout.write(`[console.${m.type()}] ${m.text()}\n`));
page.on('pageerror', (e) => process.stdout.write(`[pageerror] ${e.message}\n`));

process.stdout.write(`Loading ${URL}\n`);
await page.goto(URL, { waitUntil: 'networkidle' });

// (1) Initial mobile shot — should show map full-width with hamburger top-left.
await page.screenshot({ path: `${SHOTS}/mobile-1-initial.png` });

// (2) Tap the hamburger.
await page.locator('.sidebar-toggle').click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/mobile-2-drawer-open.png` });

// (3) Pick Aalborg.
const packButton = page.locator('button:has-text("Aalborg")').first();
await packButton.click();
process.stdout.write('Waiting for pack to load…\n');
await page.waitForFunction(() => Boolean(document.querySelector('.maplibregl-canvas')), {
  timeout: 120_000,
});
await page.waitForTimeout(3000);
await page.screenshot({ path: `${SHOTS}/mobile-3-pack-loaded.png` });

// (4) Search.
const searchInput = page.locator('input[placeholder*="Place name"]');
await searchInput.fill('Nørholmsvej 59');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOTS}/mobile-4-search-results.png` });

// (5) Pick the first result — drawer should auto-close.
await page.locator('.result-list li').first().click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOTS}/mobile-5-after-select.png` });

// (6) Reopen drawer, pick start waypoint (which auto-closes drawer for
// map interaction). Then capture the route panel.
await page.locator('.sidebar-toggle').click();
await page.waitForTimeout(400);

// Click somewhere on the map first to set a start point. We do this by
// arming start-pick, then tapping the map roughly centre.
const startBtn = page.locator('button:has-text("A:")');
if ((await startBtn.count()) > 0) {
  await startBtn.first().click();
  await page.waitForTimeout(400);
  // Now drawer should be closed and map clickable.
  const map = page.locator('.maplibregl-canvas');
  const box = await map.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1500);
  }
  await page.locator('.sidebar-toggle').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/mobile-6-waypoint-address.png` });
}

process.stdout.write('Screenshots in packs/mobile-*.png\n');
await browser.close();
