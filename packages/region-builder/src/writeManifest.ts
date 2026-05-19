import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RegionManifest } from '@openmaps/core';
import type { SyntheticData } from './synthetic.js';

export interface ManifestOpts {
  packDir: string;
  id: string;
  name: string;
  country: string;
  data: SyntheticData;
  builderCommit: string;
  tileSample: { z: number; x: number; y: number };
  /**
   * Self-test anchors. If omitted, a generic set derived from the bbox is
   * used (search terms default to the pack name, reverse/route points placed
   * at fractional bbox positions). Pass real values for real-OSM packs.
   */
  anchors?: {
    searchTerms?: ReadonlyArray<string>;
    reversePoint?: { lat: number; lon: number };
    routeWaypoints?: ReadonlyArray<{ lat: number; lon: number }>;
  };
}

export async function writeManifest(opts: ManifestOpts): Promise<RegionManifest> {
  const tilesPath = join(opts.packDir, 'tiles.mbtiles');
  const geocodePath = join(opts.packDir, 'geocode.sqlite');
  // routing/ is reserved for engines that need separate files; for the
  // InternalRouter the data is inside geocode.sqlite, but we still declare
  // a "routing" entry pointing at the same file so the manifest shape is
  // consistent and ready for BRouter/Valhalla swaps.
  const tilesStat = await stat(tilesPath);
  const geocodeStat = await stat(geocodePath);
  const tilesHash = await sha256OfFile(tilesPath);
  const geocodeHash = await sha256OfFile(geocodePath);

  const manifest: RegionManifest = {
    schemaVersion: 1,
    id: opts.id,
    name: opts.name,
    country: opts.country,
    bbox: opts.data.bbox,
    builtAt: new Date().toISOString(),
    builderCommit: opts.builderCommit,
    files: {
      tiles: { path: 'tiles.mbtiles', bytes: tilesStat.size, sha256: tilesHash },
      geocode: { path: 'geocode.sqlite', bytes: geocodeStat.size, sha256: geocodeHash },
      // For now points at geocode.sqlite (InternalRouter uses it). A real
      // BRouter pack would point to a routing/ directory of .rd5 files.
      routing: { path: 'geocode.sqlite', bytes: geocodeStat.size, sha256: geocodeHash },
    },
    selfTestAnchors: {
      searchTerms: opts.anchors?.searchTerms ? [...opts.anchors.searchTerms] : ['Faketown', 'Avenue A'],
      reversePoint: opts.anchors?.reversePoint ?? {
        lat: opts.data.bbox[1] + (opts.data.bbox[3] - opts.data.bbox[1]) * 0.6,
        lon: opts.data.bbox[0] + (opts.data.bbox[2] - opts.data.bbox[0]) * 0.6,
      },
      routeWaypoints: opts.anchors?.routeWaypoints
        ? [
            { lat: opts.anchors.routeWaypoints[0]!.lat, lon: opts.anchors.routeWaypoints[0]!.lon },
            { lat: opts.anchors.routeWaypoints[1]!.lat, lon: opts.anchors.routeWaypoints[1]!.lon },
          ]
        : [
            {
              lat: opts.data.bbox[1] + (opts.data.bbox[3] - opts.data.bbox[1]) * 0.2,
              lon: opts.data.bbox[0] + (opts.data.bbox[2] - opts.data.bbox[0]) * 0.2,
            },
            {
              lat: opts.data.bbox[1] + (opts.data.bbox[3] - opts.data.bbox[1]) * 0.8,
              lon: opts.data.bbox[0] + (opts.data.bbox[2] - opts.data.bbox[0]) * 0.8,
            },
          ],
      tileSample: opts.tileSample,
    },
  };

  await writeFile(join(opts.packDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

async function sha256OfFile(path: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => h.update(chunk))
      .on('error', reject)
      .on('end', () => resolve());
  });
  return h.digest('hex');
}
