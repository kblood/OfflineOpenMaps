/**
 * End-to-end test for the PBF ingestion path. Builds a tiny PBF file by hand
 * (via the test-only writeTestPbf helper that emits the same wire format the
 * parser library reads), then drives the full region-builder pipeline:
 *
 *   PBF file → readOsmPbf → osmToPack → writeMbtiles + writeGeocodeDb +
 *   writeManifest → FsPackStorage.open → runSelfTest.
 *
 * If this passes, real Geofabrik PBFs will work the same way — the only
 * thing changing is the data scale.
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
import { writeTestPbf } from '../../region-builder/tests/writeTestPbf.js';
import type { RawOsm } from '../../region-builder/src/osmTypes.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const builderCli = resolve(repoRoot, 'packages/region-builder/dist/cli.js');

let workDir: string;
let packsDir: string;
let pbfPath: string;
const PACK_ID = 'pbftown';

/** Build a slightly richer fixture than tinytown — a 4x4 grid + named places. */
function buildPbfFixture(): RawOsm {
  const nodes: RawOsm['nodes'] = [];
  const ways: RawOsm['ways'] = [];
  const GRID = 4;
  const cy = 55.7;
  const cx = 12.5;
  const step = 0.005;
  for (let gy = 0; gy < GRID; gy += 1) {
    for (let gx = 0; gx < GRID; gx += 1) {
      const id = 1000 + gy * GRID + gx;
      nodes.push({
        id,
        lat: cy + gy * step,
        lon: cx + gx * step,
        tags: new Map(),
      });
    }
  }
  // Named POI sitting on a grid intersection.
  nodes.push({
    id: 2001,
    lat: cy + 2 * step,
    lon: cx + 2 * step,
    tags: new Map([
      ['place', 'village'],
      ['name', 'PbfTown'],
    ]),
  });

  // Streets (horizontal): each row is one way connecting GRID nodes.
  for (let gy = 0; gy < GRID; gy += 1) {
    const refs: number[] = [];
    for (let gx = 0; gx < GRID; gx += 1) {
      refs.push(1000 + gy * GRID + gx);
    }
    ways.push({
      id: 3000 + gy,
      nodeRefs: refs,
      tags: new Map([
        ['highway', 'residential'],
        ['name', `Street ${gy + 1}`],
      ]),
    });
  }
  // Avenues (vertical).
  for (let gx = 0; gx < GRID; gx += 1) {
    const refs: number[] = [];
    for (let gy = 0; gy < GRID; gy += 1) {
      refs.push(1000 + gy * GRID + gx);
    }
    ways.push({
      id: 4000 + gx,
      nodeRefs: refs,
      tags: new Map([
        ['highway', 'residential'],
        ['name', `Avenue ${String.fromCharCode(65 + gx)}`],
      ]),
    });
  }
  return { nodes, ways };
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'openmaps-v2-pbf-'));
  packsDir = await mkdtemp(join(tmpdir(), 'openmaps-v2-pbfpacks-'));
  pbfPath = join(workDir, 'pbftown.osm.pbf');
  writeTestPbf(pbfPath, buildPbfFixture());

  execFileSync(
    'node',
    [
      builderCli,
      'build-pbf',
      '--pbf',
      pbfPath,
      '--id',
      PACK_ID,
      '--name',
      'PbfTown',
      '--country',
      'DK',
      '--out',
      packsDir,
    ],
    { stdio: 'pipe' },
  );
}, 60000);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
  if (packsDir) await rm(packsDir, { recursive: true, force: true });
});

describe('PBF pack — full offline pipeline', () => {
  it('verify() passes on a freshly-built PBF pack', async () => {
    const storage = new FsPackStorage(packsDir);
    const result = await storage.verify(PACK_ID);
    expect(result).toEqual({ ok: true });
  });

  it('runSelfTest returns 4/4 pass on the PBF-derived pack', async () => {
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

  it('forward search finds the named place from the PBF data', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const results = await pack.geocode.search('Pbf');
      expect(results.some((r) => r.displayName === 'PbfTown')).toBe(true);
    } finally {
      await pack.close();
    }
  });

  it('forward search finds a road name parsed out of the PBF', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const results = await pack.geocode.search('Avenue B');
      expect(results.some((r) => r.displayName === 'Avenue B')).toBe(true);
    } finally {
      await pack.close();
    }
  });

  it('routing between two grid corners produces a multi-segment polyline', async () => {
    const storage = new FsPackStorage(packsDir);
    const pack = await storage.open(PACK_ID);
    try {
      const [a, b] = pack.manifest.selfTestAnchors.routeWaypoints;
      const route = await pack.router.route({ waypoints: [a, b], profile: 'car' });
      expect(route.engine).toBe('internal-dijkstra');
      expect(route.distanceM).toBeGreaterThan(0);
      // 4x4 grid: a real Dijkstra path between opposite-quadrant nodes
      // must traverse more than just the two endpoints.
      expect(route.geometry.length).toBeGreaterThan(2);
    } finally {
      await pack.close();
    }
  });
});
