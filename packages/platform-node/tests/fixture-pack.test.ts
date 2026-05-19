/**
 * The whole-pipeline integration test. Builds the synthetic fixture pack into
 * a temp dir, opens it via FsPackStorage, then runs the canonical
 * runSelfTest() — the same function called by the in-app SelfTestPanel.
 *
 * If all four checks pass here, the offline architecture is sound.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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

let packsDir: string;
const PACK_ID = 'fakeland';

beforeAll(async () => {
  packsDir = await mkdtemp(join(tmpdir(), 'openmaps-v2-test-'));
  // Build the synthetic pack into the temp dir. The builder must already be
  // compiled (vitest run is preceded by `tsc -b` in CI; in dev we run it
  // explicitly).
  execFileSync('node', [builderCli, 'build-synthetic', '--id', PACK_ID, '--out', packsDir], {
    stdio: 'pipe',
  });
}, 60000);

afterAll(async () => {
  if (packsDir) await rm(packsDir, { recursive: true, force: true });
});

describe('fixture pack — full offline pipeline', () => {
  it('FsPackStorage lists the installed pack', async () => {
    const storage = new FsPackStorage(packsDir);
    const installed = await storage.listInstalled();
    expect(installed.map((m) => m.id)).toContain(PACK_ID);
  });

  it('verify() reports ok for a freshly-built pack', async () => {
    const storage = new FsPackStorage(packsDir);
    const result = await storage.verify(PACK_ID);
    expect(result).toEqual({ ok: true });
  });

  it('runSelfTest returns 4/4 pass on the freshly-built pack', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const report = await runSelfTest(pack);
      // If this fails, the offline architecture is broken — print details so
      // we can see WHICH check broke and why.
      if (!report.allPassed) {
        // eslint-disable-next-line no-console
        console.error('SelfTest report:', JSON.stringify(report, null, 2));
      }
      expect(report.allPassed).toBe(true);
      expect(report.results.map((r) => r.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    } finally {
      await pack.close();
    }
  });

  it('search returns Faketown when queried for "Fake"', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const results = await pack.geocode.search('Fake');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.displayName).toBe('Faketown');
    } finally {
      await pack.close();
    }
  });

  it('reverse geocode at grid center finds a road', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const bbox = pack.manifest.bbox;
      const cy = (bbox[1] + bbox[3]) / 2;
      const cx = (bbox[0] + bbox[2]) / 2;
      const r = await pack.geocode.reverse(cy, cx, { maxRadiusM: 2000 });
      expect(r).not.toBeNull();
      expect(r?.road).toBeDefined();
    } finally {
      await pack.close();
    }
  });

  it('route from corner to corner is a real path (not Haversine-jitter)', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const [a, b] = pack.manifest.selfTestAnchors.routeWaypoints;
      const route = await pack.router.route({ waypoints: [a, b], profile: 'car' });
      expect(route.engine).toBe('internal-dijkstra');
      // Real grid routing should give us many more geometry points than just
      // the two endpoints — that's the marker distinguishing it from
      // the v1 "two-point straight line + jitter" fake.
      expect(route.geometry.length).toBeGreaterThan(3);
      expect(route.distanceM).toBeGreaterThan(0);
      expect(route.steps.length).toBeGreaterThan(1);
    } finally {
      await pack.close();
    }
  });

  it('a Haversine-fake router would FAIL the self-test (sanity check on our guard)', async () => {
    // Sanity: confirm our self-test's "implausibly short" guard would have
    // caught v1's behavior. We construct a fake router that returns
    // start->end direct.
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const [a, b] = pack.manifest.selfTestAnchors.routeWaypoints;
      const fakeRoute = {
        geometry: [[a.lon, a.lat], [b.lon, b.lat]] as Array<[number, number]>,
        distanceM: 1, // absurdly short
        durationS: 1,
        steps: [],
        engine: 'haversine-jitter',
      };
      const fakePack = {
        ...pack,
        router: {
          supportedProfiles: ['car'] as const,
          async route() {
            return fakeRoute;
          },
          async close() {},
        },
      };
      const report = await runSelfTest(fakePack);
      expect(report.allPassed).toBe(false);
      const routeCheck = report.results.find((r) => r.id === 'route');
      expect(routeCheck?.status).toBe('fail');
      expect(routeCheck?.summary).toMatch(/shorter than crow-fly/);
    } finally {
      await pack.close();
    }
  });
});
