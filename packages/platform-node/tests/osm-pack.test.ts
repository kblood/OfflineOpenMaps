/**
 * End-to-end test for the OSM-XML ingestion path. Builds a pack from a real
 * OSM XML extract (tinytown.osm, hand-written but in real OSM format), then
 * runs the same `runSelfTest()` that the in-app SelfTestPanel uses.
 *
 * This is the proof that the OSM pipeline produces a routable, searchable,
 * reverse-geocodable pack — not just synthetic-fixture data.
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
const osmFixture = resolve(
  repoRoot,
  'packages/region-builder/tests/fixtures/tinytown.osm',
);

let packsDir: string;
const PACK_ID = 'tinytown';

beforeAll(async () => {
  packsDir = await mkdtemp(join(tmpdir(), 'openmaps-v2-osm-test-'));
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
      'Tinytown',
      '--country',
      'AD',
      '--out',
      packsDir,
    ],
    { stdio: 'pipe' },
  );
}, 60000);

afterAll(async () => {
  if (packsDir) await rm(packsDir, { recursive: true, force: true });
});

describe('OSM-XML pack — full offline pipeline', () => {
  it('verify() passes on a freshly-built OSM pack', async () => {
    const storage = new FsPackStorage(packsDir);
    const result = await storage.verify(PACK_ID);
    expect(result).toEqual({ ok: true });
  });

  it('runSelfTest returns 4/4 pass on the OSM-derived pack', async () => {
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

  it('forward search finds the named place from the OSM data', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const results = await pack.geocode.search('Tiny');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.displayName === 'Tinytown')).toBe(true);
    } finally {
      await pack.close();
    }
  });

  it('forward search finds a road name from the OSM ways', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const results = await pack.geocode.search('Main Street');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.displayName === 'Main Street')).toBe(true);
    } finally {
      await pack.close();
    }
  });

  it('route between the manifest anchor waypoints is a real path', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const [a, b] = pack.manifest.selfTestAnchors.routeWaypoints;
      const route = await pack.router.route({ waypoints: [a, b], profile: 'car' });
      expect(route.engine).toBe('internal-dijkstra');
      expect(route.geometry.length).toBeGreaterThanOrEqual(2);
      expect(route.distanceM).toBeGreaterThan(0);
    } finally {
      await pack.close();
    }
  });
});
