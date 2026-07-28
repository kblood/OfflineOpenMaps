import { describe, expect, it, vi } from 'vitest';
import type {
  GeocodeIndex,
  PackStorage,
  RegionManifest,
  RegionPack,
  Router,
  TileSource,
} from '../src/index.js';
import { OpenMapsClient, OpenMapsClientError } from '../src/index.js';

const manifest: RegionManifest = {
  schemaVersion: 1,
  id: 'test-pack',
  name: 'Test Pack',
  country: 'DK',
  bbox: [9, 55, 11, 57],
  builtAt: '2026-07-28T00:00:00.000Z',
  builderCommit: 'abcdef1',
  files: {
    tiles: { path: 'tiles.mbtiles', bytes: 1, sha256: 'a'.repeat(64) },
    geocode: { path: 'map.sqlite', bytes: 1, sha256: 'b'.repeat(64) },
    routing: { path: 'map.sqlite', bytes: 1, sha256: 'b'.repeat(64) },
  },
  selfTestAnchors: {
    searchTerms: ['Aarhus'],
    reversePoint: { lat: 56, lon: 10 },
    routeWaypoints: [{ lat: 56, lon: 10 }, { lat: 56.01, lon: 10.01 }],
    tileSample: { z: 1, x: 1, y: 1 },
  },
};

function createPack(close = vi.fn(async () => undefined)): RegionPack {
  const tiles: TileSource = {
    meta: { minZoom: 0, maxZoom: 18, bounds: manifest.bbox, format: 'mvt', attribution: 'test' },
    async getTile() { return { bytes: new Uint8Array([1, 2]), contentType: 'application/x-protobuf', contentEncoding: 'none' }; },
    async close() {},
  };
  const geocode: GeocodeIndex = {
    async search() { return [{ id: '1', displayName: 'Aarhus', kind: 'place', lat: 56, lon: 10, country: 'DK', score: 1 }]; },
    async reverse() { return { displayName: 'Aarhus', kind: 'place', distanceM: 0 }; },
    async getParcel() { return null; },
    async close() {},
  };
  const router: Router = {
    supportedProfiles: ['car'],
    async route() { return { geometry: [[10, 56], [10.01, 56.01]], distanceM: 1500, durationS: 120, steps: [], engine: 'test' }; },
    async close() {},
  };
  return { manifest, tiles, geocode, router, close };
}

function createStorage(pack: RegionPack): PackStorage {
  return {
    async listInstalled() { return [manifest]; },
    async open() { return pack; },
    async verify() { return { ok: true }; },
    async uninstall() {},
  };
}

describe('OpenMapsClient', () => {
  it('provides one facade for pack lifecycle and runtime capabilities', async () => {
    const pack = createPack();
    const client = new OpenMapsClient(createStorage(pack));
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));

    await expect(client.listPacks()).resolves.toEqual([manifest]);
    await expect(client.openPack('test-pack')).resolves.toBe(manifest);
    await expect(client.search('Aarhus')).resolves.toHaveLength(1);
    await expect(client.getTile(1, 1, 1)).resolves.toMatchObject({ contentEncoding: 'none' });
    await expect(client.route({ waypoints: manifest.selfTestAnchors.routeWaypoints, profile: 'car' })).resolves.toMatchObject({ engine: 'test' });
    expect(events).toEqual(['pack-opening', 'pack-opened']);

    await client.dispose();
    expect(pack.close).toHaveBeenCalledOnce();
    expect(() => client.search('after dispose')).toThrow(OpenMapsClientError);
  });

  it('serialises competing pack transitions', async () => {
    const first = createPack();
    const second = createPack();
    let opens = 0;
    const storage = createStorage(first);
    storage.open = vi.fn(async () => (++opens === 1 ? first : second));
    const client = new OpenMapsClient(storage);

    await Promise.all([client.openPack('first'), client.openPack('second')]);
    expect(client.current).toBe(second);
    expect(first.close).toHaveBeenCalledOnce();
    await client.dispose();
  });
});
