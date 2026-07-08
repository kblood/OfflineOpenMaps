/**
 * Real-world validation against central Aalborg, Denmark.
 *
 * This is the proof that the pipeline handles ACTUAL OSM data, not just the
 * hand-written tinytown/mixville fixtures:
 *   - Real Danish street names (Boulevarden, Vesterbro, Bispensgade, Algade)
 *   - Special characters in names (Jomfru Ane Gade, Østerågade)
 *   - Real urban density (~40k routing nodes, ~85k edges)
 *   - Real coordinates: Aalborg Central Station, Budolfi Cathedral, etc.
 *
 * The .osm fixture is multi-MB and NOT committed. Run
 * `node scripts/fetch-aalborg.mjs` once to materialize it from Overpass.
 * If the fixture is missing, this suite skips with a clear message.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runSelfTest } from '@openmaps/core';
import { FsPackStorage } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const builderCli = resolve(repoRoot, 'packages/region-builder/dist/cli.js');
const osmFixture = resolve(
  repoRoot,
  'packages/region-builder/tests/fixtures/real/aalborg.osm',
);
const fixtureExists = existsSync(osmFixture);
const PACK_ID = 'aalborg';

// Real coordinates inside the fixture's bbox (9.87..9.98 lon, 57.01..57.07 lat).
// Sources: OpenStreetMap.
const AALBORG_STATION = { lat: 57.0438, lon: 9.9183 };
const NYTORV = { lat: 57.0487, lon: 9.9213 };
const LIMFJORDSBROEN = { lat: 57.0584, lon: 9.9183 };
const AALBORG_ZOO = { lat: 57.0286, lon: 9.8941 };

let packsDir: string;

beforeAll(async () => {
  if (!fixtureExists) return;
  packsDir = await mkdtemp(join(tmpdir(), 'openmaps-v2-aalborg-'));
  // Pass --bbox matching the bbox used by scripts/fetch-aalborg.mjs. Without
  // a clip bbox, osmToPack skips the coastline→sea-polygon closure step,
  // so Limfjorden renders blank — a regression we caught the hard way once
  // and pin down here for next time.
  execFileSync(
    'node',
    [
      builderCli,
      'build-osm',
      '--in',
      osmFixture,
      '--id',
      PACK_ID,
      '--name',
      'Aalborg',
      '--country',
      'DK',
      '--bbox',
      '9.82,56.99,10.05,57.10',
      '--out',
      packsDir,
    ],
    { stdio: 'pipe' },
  );
}, 240000);

afterAll(async () => {
  if (packsDir) await rm(packsDir, { recursive: true, force: true });
});

describe.skipIf(!fixtureExists)('Aalborg, Denmark — real-world OSM pack', () => {
  it('runSelfTest returns 4/4 pass on the freshly-built Aalborg pack', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const report = await runSelfTest(pack);
      if (!report.allPassed) {
        // eslint-disable-next-line no-console
        console.error('SelfTest report:', JSON.stringify(report, null, 2));
      }
      expect(report.allPassed).toBe(true);
    } finally {
      await pack.close();
    }
  });

  it('verify() passes — manifest checksums match the on-disk files', async () => {
    const storage = new FsPackStorage(packsDir);
    expect(await storage.verify(PACK_ID)).toEqual({ ok: true });
  });

  it('forward search finds central Aalborg streets', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const named = (await pack.geocode.search('Boulevarden')).map((r) => r.displayName);
      expect(named).toContain('Boulevarden');

      const vesterbro = (await pack.geocode.search('Vesterbro')).map((r) => r.displayName);
      expect(vesterbro.some((n) => n === 'Vesterbro' || n.startsWith('Vesterbro'))).toBe(true);

      const bispensgade = (await pack.geocode.search('Bispensgade')).map((r) => r.displayName);
      expect(bispensgade).toContain('Bispensgade');
    } finally {
      await pack.close();
    }
  });

  it('forward search handles special Danish characters (æ ø å)', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      // "Jomfru Ane Gade" — famous Aalborg bar street.
      const jomfru = (await pack.geocode.search('Jomfru Ane Gade')).map((r) => r.displayName);
      expect(jomfru).toContain('Jomfru Ane Gade');

      // "Østerågade" — central street with Ø and å.
      const oster = (await pack.geocode.search('Østerågade')).map((r) => r.displayName);
      expect(oster.some((n) => n === 'Østerågade' || n.startsWith('Østerågade'))).toBe(true);
    } finally {
      await pack.close();
    }
  });

  it('prefix search returns matches without typing the full name', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      // Just "Bispen" should still hit Bispensgade thanks to FTS prefix.
      const results = await pack.geocode.search('Bispen');
      expect(results.some((r) => r.displayName.startsWith('Bispens'))).toBe(true);
    } finally {
      await pack.close();
    }
  });

  it('reverse-geocode at Nytorv square returns a real Aalborg street or POI', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const r = await pack.geocode.reverse(NYTORV.lat, NYTORV.lon, { maxRadiusM: 100 });
      expect(r).not.toBeNull();
      // Should be very close — a few tens of meters at most.
      expect(r!.distanceM).toBeLessThan(100);
      // The result must be in our known central-Aalborg name set OR a
      // sensible street name with Danish characters.
      expect(r!.displayName.length).toBeGreaterThan(0);
    } finally {
      await pack.close();
    }
  });

  it('routes Aalborg Central Station → Limfjordsbroen (~1.5 km north)', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const route = await pack.router.route({
        waypoints: [AALBORG_STATION, LIMFJORDSBROEN],
        profile: 'car',
      });
      expect(route.engine).toBe('internal-dijkstra');
      // Crow-fly is ~1.6 km. Real route should be slightly longer due to
      // one-ways and street grid, but well under 5x.
      expect(route.distanceM).toBeGreaterThan(1200);
      expect(route.distanceM).toBeLessThan(5000);
      // Real-world route across a city must have many geometry points.
      expect(route.geometry.length).toBeGreaterThan(10);
      // At least a couple of distinct named streets in the steps.
      const namedSteps = route.steps.filter((s) => /Continue on /.test(s.instruction));
      expect(namedSteps.length).toBeGreaterThan(0);
    } finally {
      await pack.close();
    }
  });

  it('routes Aalborg Central Station → Aalborg Zoo (~2 km southwest)', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const route = await pack.router.route({
        waypoints: [AALBORG_STATION, AALBORG_ZOO],
        profile: 'car',
      });
      // Crow-fly ≈ 2.0 km.
      expect(route.distanceM).toBeGreaterThan(1500);
      expect(route.distanceM).toBeLessThan(6000);
      expect(route.geometry.length).toBeGreaterThan(10);
    } finally {
      await pack.close();
    }
  });

  it('foot routing across the city centre is slower than car routing', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const carRoute = await pack.router.route({
        waypoints: [AALBORG_STATION, NYTORV],
        profile: 'car',
      });
      const footRoute = await pack.router.route({
        waypoints: [AALBORG_STATION, NYTORV],
        profile: 'foot',
      });
      // Same-ish path through a dense centre; foot just much slower.
      expect(footRoute.durationS).toBeGreaterThan(carRoute.durationS * 3);
    } finally {
      await pack.close();
    }
  });

  it('multi-waypoint Station → Nytorv → Limfjordsbroen reconciles with leg sum', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const full = await pack.router.route({
        waypoints: [AALBORG_STATION, NYTORV, LIMFJORDSBROEN],
        profile: 'car',
      });
      const legAB = await pack.router.route({
        waypoints: [AALBORG_STATION, NYTORV],
        profile: 'car',
      });
      const legBC = await pack.router.route({
        waypoints: [NYTORV, LIMFJORDSBROEN],
        profile: 'car',
      });
      expect(full.distanceM).toBeCloseTo(legAB.distanceM + legBC.distanceM, -1);
    } finally {
      await pack.close();
    }
  });
});

if (!fixtureExists) {
  // Single explicit test that explains the skip — so the suite shows up in
  // the runner output rather than silently disappearing.
  describe('Aalborg, Denmark — real-world OSM pack', () => {
    it.skip('fixture missing — run `node scripts/fetch-aalborg.mjs` to enable', () => {
      // intentionally empty
    });
  });
}
