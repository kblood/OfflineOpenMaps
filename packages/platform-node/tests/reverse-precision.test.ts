/**
 * Targeted tests for reverse-geocode precision. The whole point of switching
 * to perpendicular-to-segment is that a point ON a road should report a
 * distance ~0, even when the road is long (and so its bbox center is far
 * away from the query point).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
  packsDir = await mkdtemp(join(tmpdir(), 'openmaps-v2-rprec-'));
  execFileSync(
    'node',
    [builderCli, 'build-osm', '--in', osmFixture, '--id', PACK_ID, '--out', packsDir],
    { stdio: 'pipe' },
  );
}, 60000);

afterAll(async () => {
  if (packsDir) await rm(packsDir, { recursive: true, force: true });
});

describe('reverse-geocode perpendicular-to-segment precision', () => {
  it('a point ON the centerline of a long road reports near-zero distance', async () => {
    // Main Street in tinytown.osm runs from (42.50, 1.56) to (42.50, 1.62) —
    // a long horizontal road. Query a point that's exactly on its centerline
    // but ~2km from the road's bbox-center (lon=1.59).
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const queryLat = 42.50;
      const queryLon = 1.57; // on the road, ~1.6km from bbox center (lon=1.59)
      const r = await pack.geocode.reverse(queryLat, queryLon, { maxRadiusM: 200 });
      expect(r).not.toBeNull();
      expect(r?.road).toBe('Main Street');
      // Perpendicular distance should be tiny (a few meters at most given the
      // discretization of lat/lon to floats). The OLD code would have reported
      // a distance equal to half the road length (~1.6km).
      expect(r!.distanceM).toBeLessThan(50);
    } finally {
      await pack.close();
    }
  });

  it('a point clearly OFF the road reports the perpendicular distance, not the corner distance', async () => {
    // Query 0.001° north of Main Street (~111m perpendicular). Old bbox-
    // center would have reported sqrt(111² + ~1600²) ≈ 1604m (corner). New
    // perpendicular should report ~111m.
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const r = await pack.geocode.reverse(42.501, 1.57, { maxRadiusM: 500 });
      expect(r).not.toBeNull();
      // Allow a generous tolerance — we just need to see it's "around 111m"
      // not "around 1600m".
      expect(r!.distanceM).toBeLessThan(200);
      expect(r!.distanceM).toBeGreaterThan(50);
    } finally {
      await pack.close();
    }
  });
});
