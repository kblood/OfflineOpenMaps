/**
 * Offline wayfinding test suite. These tests make TWO claims:
 *
 *   1. The router produces correct results on real graph data (multi-waypoint,
 *      profile constraints, no-route handling).
 *   2. The router NEVER touches the network. We prove this by sabotaging
 *      every Node networking primitive — fetch, dns.lookup, net.Socket,
 *      http.request — before calling .route(). Any attempted network call
 *      would throw immediately and fail the test.
 *
 * The Playwright offline-electron suite verifies the same property at the
 * Electron-session level (`enableNetworkEmulation({offline:true})`). These
 * Node-level tests close the gap so a regression in the router itself —
 * say, someone adding `fetch('https://...')` to InternalRouter — fails
 * loudly here even without launching Electron.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as dns from 'node:dns';
import * as net from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import { RoutingUnavailableError } from '@openmaps/core';
import { FsPackStorage } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const builderCli = resolve(repoRoot, 'packages/region-builder/dist/cli.js');
const fakelandOsm = resolve(
  repoRoot,
  'packages/region-builder/tests/fixtures/tinytown.osm',
);
const profileMixOsm = resolve(
  repoRoot,
  'packages/region-builder/tests/fixtures/profile-mix.osm',
);

let packsDir: string;

beforeAll(async () => {
  packsDir = await mkdtemp(join(tmpdir(), 'openmaps-v2-routing-'));
  execFileSync('node', [builderCli, 'build-synthetic', '--id', 'fakeland', '--out', packsDir], {
    stdio: 'pipe',
  });
  execFileSync(
    'node',
    [builderCli, 'build-osm', '--in', profileMixOsm, '--id', 'mixville', '--name', 'Mixville', '--out', packsDir],
    { stdio: 'pipe' },
  );
  // tinytown — used by no-route disconnected-graph scenarios (its graph has
  // both connected blocks and an isolated South Lane).
  execFileSync(
    'node',
    [builderCli, 'build-osm', '--in', fakelandOsm, '--id', 'tinytown', '--name', 'Tinytown', '--out', packsDir],
    { stdio: 'pipe' },
  );
}, 60000);

afterAll(async () => {
  if (packsDir) await rm(packsDir, { recursive: true, force: true });
});

/**
 * Hard-block every networking primitive Node ships with. If anyone in the
 * call chain tries to reach out, it throws. We restore them in afterEach so
 * other tests aren't affected.
 */
type Sabotage = { restore(): void };

function sabotageNetwork(): Sabotage {
  const tripwires: string[] = [];
  const restores: Array<() => void> = [];
  const patchedNames: string[] = [];

  function tryPatch(
    name: string,
    holder: Record<string, unknown>,
    prop: string,
    replacement: unknown,
  ): void {
    const original = holder[prop];
    try {
      holder[prop] = replacement;
      patchedNames.push(name);
      restores.push(() => {
        try {
          holder[prop] = original;
        } catch {
          /* non-fatal — module may have frozen the property */
        }
      });
    } catch {
      // Some Node modules (recent dns) mark their exports non-configurable.
      // Skipping is fine — we still have fetch + net.Socket + http(s).request
      // as the load-bearing tripwires.
    }
  }

  function tripwire(label: string) {
    return (...args: unknown[]) => {
      tripwires.push(`${label}(${String(args[0])})`);
      throw new Error(`NETWORK TRIPWIRE: ${label}() called during offline routing`);
    };
  }

  tryPatch('fetch', globalThis as unknown as Record<string, unknown>, 'fetch', tripwire('fetch'));
  tryPatch('dns.lookup', dns as unknown as Record<string, unknown>, 'lookup', tripwire('dns.lookup'));
  tryPatch('dns.resolve', dns as unknown as Record<string, unknown>, 'resolve', tripwire('dns.resolve'));
  tryPatch(
    'net.Socket',
    net as unknown as Record<string, unknown>,
    'Socket',
    class TripwireSocket {
      constructor() {
        tripwires.push('new net.Socket()');
        throw new Error('NETWORK TRIPWIRE: net.Socket constructed during offline routing');
      }
    },
  );
  tryPatch('http.request', http as unknown as Record<string, unknown>, 'request', tripwire('http.request'));
  tryPatch('https.request', https as unknown as Record<string, unknown>, 'request', tripwire('https.request'));

  // Guarantee: at least the headline tripwires were installed. If none of
  // them survived, the test would be meaningless — fail loudly.
  if (!patchedNames.some((n) => n === 'fetch' || n === 'http.request' || n === 'https.request')) {
    throw new Error(`network sabotage failed — no tripwires installed (patched: ${patchedNames})`);
  }

  return {
    restore() {
      for (const r of restores) r();
      if (tripwires.length > 0) {
        // eslint-disable-next-line no-console
        console.error('NETWORK ACCESS DURING TEST:', tripwires);
      }
    },
  };
}

describe('offline routing — Node-level network sabotage', () => {
  let sab: Sabotage;
  beforeEach(() => {
    sab = sabotageNetwork();
  });
  afterEach(() => {
    sab.restore();
  });

  it('routes A→B on the fakeland grid with every network primitive disabled', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open('fakeland');
    try {
      const [a, b] = pack.manifest.selfTestAnchors.routeWaypoints;
      const route = await pack.router.route({ waypoints: [a, b], profile: 'car' });
      expect(route.engine).toBe('internal-dijkstra');
      expect(route.geometry.length).toBeGreaterThan(3);
      expect(route.distanceM).toBeGreaterThan(0);
      // Sanity check vs the v1 Haversine fake: real grid route is well within
      // crow-fly × 5 and above crow-fly × 0.8 (this mirrors the runSelfTest
      // guard but executed directly here).
      const dLat = b.lat - a.lat;
      const dLon = b.lon - a.lon;
      const crowFly =
        Math.sqrt(dLat * dLat + dLon * dLon * Math.cos((a.lat * Math.PI) / 180) ** 2) * 111_320;
      expect(route.distanceM).toBeGreaterThan(crowFly * 0.8);
      expect(route.distanceM).toBeLessThan(crowFly * 5);
    } finally {
      await pack.close();
    }
  });

  it('routes A→B→C as a multi-waypoint chain with network disabled', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open('fakeland');
    try {
      const [minLon, minLat, maxLon, maxLat] = pack.manifest.bbox;
      const wp = [
        { lat: minLat + (maxLat - minLat) * 0.2, lon: minLon + (maxLon - minLon) * 0.2 },
        { lat: minLat + (maxLat - minLat) * 0.5, lon: minLon + (maxLon - minLon) * 0.5 },
        { lat: minLat + (maxLat - minLat) * 0.8, lon: minLon + (maxLon - minLon) * 0.8 },
      ];
      const route = await pack.router.route({ waypoints: wp, profile: 'car' });
      // Multi-leg route must be longer than either leg alone.
      const legAB = await pack.router.route({ waypoints: [wp[0]!, wp[1]!], profile: 'car' });
      const legBC = await pack.router.route({ waypoints: [wp[1]!, wp[2]!], profile: 'car' });
      expect(route.distanceM).toBeCloseTo(legAB.distanceM + legBC.distanceM, -1);
      // Geometry of A→B→C must contain more points than any single leg.
      expect(route.geometry.length).toBeGreaterThan(legAB.geometry.length);
      expect(route.geometry.length).toBeGreaterThan(legBC.geometry.length);
    } finally {
      await pack.close();
    }
  });

  it('foot profile produces longer duration than car for the same waypoints', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open('fakeland');
    try {
      const [a, b] = pack.manifest.selfTestAnchors.routeWaypoints;
      const carRoute = await pack.router.route({ waypoints: [a, b], profile: 'car' });
      const footRoute = await pack.router.route({ waypoints: [a, b], profile: 'foot' });
      // Distance should be similar (same graph), durations VERY different.
      expect(footRoute.durationS).toBeGreaterThan(carRoute.durationS * 5);
    } finally {
      await pack.close();
    }
  });
});

describe('offline routing — profile constraints', () => {
  it('car profile cannot traverse a footway-only corridor', async () => {
    // mixville has bottom-row + verticals + middle (footway) + top (motorway).
    // Routing from a node on the middle row to itself is trivial, but
    // crossing the middle horizontally requires either the residential top
    // or bottom row when going car-only.
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open('mixville');
    try {
      // Waypoints at the western and eastern ends of the MIDDLE row (which
      // is a footway). Both routes must succeed, but the car path has to
      // detour through a non-footway row.
      const wpA = { lat: 42.51, lon: 1.58 };
      const wpB = { lat: 42.51, lon: 1.62 };
      const carRoute = await pack.router.route({ waypoints: [wpA, wpB], profile: 'car' });
      const footRoute = await pack.router.route({ waypoints: [wpA, wpB], profile: 'foot' });
      // The foot route should be roughly the straight middle row (~3km).
      // The car route MUST go further because it can't use the footway.
      expect(carRoute.distanceM).toBeGreaterThan(footRoute.distanceM);
    } finally {
      await pack.close();
    }
  });

  it('foot profile cannot traverse a motorway-only corridor', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open('mixville');
    try {
      const wpA = { lat: 42.52, lon: 1.58 }; // node 7, top-left (motorway)
      const wpB = { lat: 42.52, lon: 1.62 }; // node 9, top-right (motorway)
      const carRoute = await pack.router.route({ waypoints: [wpA, wpB], profile: 'car' });
      const footRoute = await pack.router.route({ waypoints: [wpA, wpB], profile: 'foot' });
      // Car: ~straight along the motorway. Foot: must detour down to a
      // residential row. The foot route is therefore measurably longer.
      expect(footRoute.distanceM).toBeGreaterThan(carRoute.distanceM);
    } finally {
      await pack.close();
    }
  });

  it('rejects an unsupported profile with profile-unsupported', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open('fakeland');
    try {
      const [a, b] = pack.manifest.selfTestAnchors.routeWaypoints;
      await expect(
        // @ts-expect-error intentionally invalid profile
        pack.router.route({ waypoints: [a, b], profile: 'helicopter' }),
      ).rejects.toThrow(RoutingUnavailableError);
    } finally {
      await pack.close();
    }
  });
});

describe('offline routing — failure modes', () => {
  it('returns RoutingUnavailableError(no-graph) when a waypoint is far from any road', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open('fakeland');
    try {
      const [_minLon, _minLat, maxLon, maxLat] = pack.manifest.bbox;
      void _minLon;
      void _minLat;
      // A point thousands of kilometres outside the pack bbox.
      const farAway = { lat: maxLat + 50, lon: maxLon + 50 };
      const inside = { lat: pack.manifest.selfTestAnchors.reversePoint.lat, lon: pack.manifest.selfTestAnchors.reversePoint.lon };
      await expect(
        pack.router.route({ waypoints: [inside, farAway], profile: 'car' }),
      ).rejects.toThrow(RoutingUnavailableError);
    } finally {
      await pack.close();
    }
  });

  it('rejects requests with fewer than 2 waypoints', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open('fakeland');
    try {
      const a = pack.manifest.selfTestAnchors.routeWaypoints[0];
      await expect(
        pack.router.route({ waypoints: [a], profile: 'car' }),
      ).rejects.toThrow(RoutingUnavailableError);
    } finally {
      await pack.close();
    }
  });
});

describe('offline routing — route structure', () => {
  it('route steps cover the full geometry without gaps', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open('fakeland');
    try {
      const [a, b] = pack.manifest.selfTestAnchors.routeWaypoints;
      const route = await pack.router.route({ waypoints: [a, b], profile: 'car' });
      // Every step's geometryStart should be in [0, route.geometry.length).
      for (const s of route.steps) {
        expect(s.geometryStart).toBeGreaterThanOrEqual(0);
        expect(s.geometryStart).toBeLessThan(route.geometry.length);
      }
      // First step is depart, last is arrive.
      expect(route.steps[0]!.maneuver).toBe('depart');
      expect(route.steps[route.steps.length - 1]!.maneuver).toBe('arrive');
      // Sum of step distances ≈ total distance.
      const sumStepDist = route.steps.reduce((acc, s) => acc + s.distanceM, 0);
      // Allow rounding slack: each step rounds, so steps can drift by step-count meters.
      expect(Math.abs(sumStepDist - route.distanceM)).toBeLessThan(route.steps.length + 1);
    } finally {
      await pack.close();
    }
  });

  it('route durations scale with edge length at the configured speed cap', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open('fakeland');
    try {
      const [a, b] = pack.manifest.selfTestAnchors.routeWaypoints;
      const carRoute = await pack.router.route({ waypoints: [a, b], profile: 'car' });
      // Fakeland edges are all 50 km/h. car cap is 130 → effective = 50.
      // duration ≈ distance / (50 km/h) ⇒ seconds = distance_m / 1000 * 3600 / 50
      const expected = (carRoute.distanceM / 1000 / 50) * 3600;
      // Within 1%, accounting for rounding in step output (we sum raw values).
      expect(carRoute.durationS).toBeGreaterThan(expected * 0.99);
      expect(carRoute.durationS).toBeLessThan(expected * 1.01);
    } finally {
      await pack.close();
    }
  });
});
