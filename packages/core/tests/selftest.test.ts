import { describe, expect, it } from 'vitest';
import { runSelfTest } from '../src/selftest/runSelfTest.js';
import type { RegionPack } from '../src/pack/RegionPack.js';
import type { RegionManifest } from '../src/pack/manifest.js';
import type { TileSource, TileBytes, TileSourceMeta } from '../src/tiles/TileSource.js';
import type { GeocodeIndex, SearchResult, ReverseResult } from '../src/geocode/GeocodeIndex.js';
import type { Router, RouteResult, Profile } from '../src/route/Router.js';
import { RoutingUnavailableError } from '../src/route/Router.js';

const manifest: RegionManifest = {
  schemaVersion: 1,
  id: 'fakeland',
  name: 'Fakeland',
  country: 'XX',
  bbox: [10, 50, 12, 52],
  builtAt: '2026-05-18T00:00:00Z',
  builderCommit: 'abc1234',
  files: {
    tiles: { path: 't.pmtiles', bytes: 1, sha256: '0'.repeat(64) },
    geocode: { path: 'g.sqlite', bytes: 1, sha256: '1'.repeat(64) },
    routing: { path: 'r/', bytes: 1, sha256: '2'.repeat(64) },
  },
  selfTestAnchors: {
    searchTerms: ['Faketown'],
    reversePoint: { lat: 51, lon: 11 },
    routeWaypoints: [
      { lat: 51, lon: 11 },
      { lat: 51.05, lon: 11.05 },
    ],
    tileSample: { z: 8, x: 100, y: 50 },
  },
};

function makePack(opts: {
  tile?: TileBytes | null;
  searchResults?: SearchResult[];
  reverseResult?: ReverseResult | null;
  routeResult?: RouteResult | (() => Promise<RouteResult>);
  routeError?: Error;
}): RegionPack {
  const tileMeta: TileSourceMeta = {
    minZoom: 0,
    maxZoom: 14,
    bounds: [10, 50, 12, 52],
    format: 'mvt',
    attribution: '© Test',
  };
  const tiles: TileSource = {
    meta: tileMeta,
    getTile: async () => opts.tile ?? null,
    close: async () => undefined,
  };
  const geocode: GeocodeIndex = {
    search: async () => opts.searchResults ?? [],
    reverse: async () => opts.reverseResult ?? null,
    close: async () => undefined,
  };
  const profiles: readonly Profile[] = ['car', 'bike', 'foot'];
  const router: Router = {
    supportedProfiles: profiles,
    route: async () => {
      if (opts.routeError) throw opts.routeError;
      if (typeof opts.routeResult === 'function') return await opts.routeResult();
      if (!opts.routeResult) throw new RoutingUnavailableError('no route', 'no-route');
      return opts.routeResult;
    },
    close: async () => undefined,
  };
  return { manifest, tiles, geocode, router, close: async () => undefined };
}

const goodTile: TileBytes = {
  bytes: new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]),
  contentType: 'application/vnd.mapbox-vector-tile',
  contentEncoding: 'gzip',
};
const goodSearch: SearchResult[] = [
  { id: '1', displayName: 'Faketown', kind: 'place', lat: 51, lon: 11, country: 'XX', score: 1 },
];
const goodReverse: ReverseResult = {
  displayName: 'Main Street 1',
  kind: 'street',
  distanceM: 5,
  road: 'Main Street',
};
const goodRoute: RouteResult = {
  // ~7km, which is reasonable for two points ~6km apart crow-fly.
  geometry: [
    [11, 51],
    [11.025, 51.025],
    [11.05, 51.05],
  ],
  distanceM: 7000,
  durationS: 600,
  steps: [],
  engine: 'fake',
};

describe('runSelfTest', () => {
  it('returns allPassed=true when all four checks succeed', async () => {
    const pack = makePack({
      tile: goodTile,
      searchResults: goodSearch,
      reverseResult: goodReverse,
      routeResult: goodRoute,
    });
    const report = await runSelfTest(pack);
    expect(report.allPassed).toBe(true);
    expect(report.results.map((r) => r.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
  });

  it('fails tiles check when getTile returns null', async () => {
    const pack = makePack({
      tile: null,
      searchResults: goodSearch,
      reverseResult: goodReverse,
      routeResult: goodRoute,
    });
    const report = await runSelfTest(pack);
    expect(report.allPassed).toBe(false);
    expect(report.results[0]?.id).toBe('tiles');
    expect(report.results[0]?.status).toBe('fail');
    expect(report.results[0]?.summary).toContain('null');
  });

  it('fails tiles check when bytes empty', async () => {
    const empty: TileBytes = { bytes: new Uint8Array(0), contentType: 'x', contentEncoding: 'none' };
    const pack = makePack({
      tile: empty,
      searchResults: goodSearch,
      reverseResult: goodReverse,
      routeResult: goodRoute,
    });
    const report = await runSelfTest(pack);
    expect(report.results[0]?.status).toBe('fail');
    expect(report.results[0]?.summary).toContain('empty');
  });

  it('fails search when no results', async () => {
    const pack = makePack({
      tile: goodTile,
      searchResults: [],
      reverseResult: goodReverse,
      routeResult: goodRoute,
    });
    const report = await runSelfTest(pack);
    expect(report.results[1]?.id).toBe('search');
    expect(report.results[1]?.status).toBe('fail');
  });

  it('fails search when top result is outside bbox', async () => {
    const out: SearchResult[] = [
      { id: 'x', displayName: 'Faketown (wrong)', kind: 'place', lat: 0, lon: 0, country: 'XX', score: 1 },
    ];
    const pack = makePack({
      tile: goodTile,
      searchResults: out,
      reverseResult: goodReverse,
      routeResult: goodRoute,
    });
    const report = await runSelfTest(pack);
    expect(report.results[1]?.status).toBe('fail');
    expect(report.results[1]?.summary).toContain('outside the pack bbox');
  });

  it('fails reverse when null', async () => {
    const pack = makePack({
      tile: goodTile,
      searchResults: goodSearch,
      reverseResult: null,
      routeResult: goodRoute,
    });
    const report = await runSelfTest(pack);
    expect(report.results[2]?.id).toBe('reverse');
    expect(report.results[2]?.status).toBe('fail');
  });

  it('fails route when distance is implausibly short (Haversine fake)', async () => {
    // The exact case from v1's fake "mathematical routing": distance == straight line.
    const fakeMath: RouteResult = {
      geometry: [
        [11, 51],
        [11.05, 51.05],
      ],
      distanceM: 1, // way less than crow-fly
      durationS: 1,
      steps: [],
      engine: 'haversine-jitter',
    };
    const pack = makePack({
      tile: goodTile,
      searchResults: goodSearch,
      reverseResult: goodReverse,
      routeResult: fakeMath,
    });
    const report = await runSelfTest(pack);
    expect(report.results[3]?.id).toBe('route');
    expect(report.results[3]?.status).toBe('fail');
    expect(report.results[3]?.summary).toMatch(/shorter than crow-fly/);
  });

  it('fails route when engine throws RoutingUnavailableError', async () => {
    const pack = makePack({
      tile: goodTile,
      searchResults: goodSearch,
      reverseResult: goodReverse,
      routeError: new RoutingUnavailableError('no graph for bbox', 'no-graph'),
    });
    const report = await runSelfTest(pack);
    expect(report.results[3]?.status).toBe('fail');
    expect(report.results[3]?.summary).toContain('no-graph');
  });

  it('fails check that exceeds the 5s timeout', async () => {
    const pack = makePack({
      tile: goodTile,
      searchResults: goodSearch,
      reverseResult: goodReverse,
      routeResult: () =>
        new Promise<RouteResult>((resolve) => setTimeout(() => resolve(goodRoute), 6000)),
    });
    const report = await runSelfTest(pack);
    expect(report.results[3]?.status).toBe('fail');
    expect(report.results[3]?.summary).toMatch(/timed out/);
  }, 10000);
});
