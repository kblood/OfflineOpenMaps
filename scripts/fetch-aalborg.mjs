#!/usr/bin/env node
/**
 * One-shot fetcher: pulls a central-Aalborg OSM XML extract from the
 * Overpass API and writes it to packages/region-builder/tests/fixtures/real/
 * for use by aalborg.test.ts.
 *
 * Run once (it's online): `node scripts/fetch-aalborg.mjs`.
 * The downloaded file is gitignored; the test runs fully offline against
 * the saved bytes.
 *
 * Skips the download if the file already exists. Pass --force to refresh.
 */
import { writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outDir = resolve(repoRoot, 'packages/region-builder/tests/fixtures/real');
const outFile = resolve(outDir, 'aalborg.osm');
const force = process.argv.includes('--force');

// Greater-Aalborg bbox: city centre, Nørresundby across the fjord,
// the western suburbs (Hasseris, Skalborg, Nørholmsvej), the eastern
// suburbs (Vejgaard), and the airport approach. (south, west, north,
// east) in WGS84. ~14 km wide × ~12 km tall.
const SOUTH = 56.99;
const WEST = 9.82;
const NORTH = 57.10;
const EAST = 10.05;

// Overpass QL — fetch highway ways + water polygons + named POIs + admin
// places, then recurse (`>;`) to include every referenced node. `out:xml`
// so it lands in the same format our XML reader handles. Water types
// covered: lakes/ponds (natural=water), river polygons
// (waterway=riverbank), harbour docks (waterway=dock), reservoirs and
// basins. Coastlines (`natural=coastline`) are open ways, not polygons,
// so they're handled separately at the renderer level via a sea
// background — not included here.
const query = `[out:xml][timeout:180];
(
  way["highway"](${SOUTH},${WEST},${NORTH},${EAST});
  way["natural"="water"](${SOUTH},${WEST},${NORTH},${EAST});
  way["waterway"="riverbank"](${SOUTH},${WEST},${NORTH},${EAST});
  way["waterway"="dock"](${SOUTH},${WEST},${NORTH},${EAST});
  way["landuse"="reservoir"](${SOUTH},${WEST},${NORTH},${EAST});
  way["landuse"="basin"](${SOUTH},${WEST},${NORTH},${EAST});
  node["place"](${SOUTH},${WEST},${NORTH},${EAST});
  node["amenity"]["name"](${SOUTH},${WEST},${NORTH},${EAST});
  node["shop"]["name"](${SOUTH},${WEST},${NORTH},${EAST});
  node["tourism"]["name"](${SOUTH},${WEST},${NORTH},${EAST});
);
out body;
>;
out skel qt;
`;

async function main() {
  if (existsSync(outFile) && !force) {
    const sz = statSync(outFile).size;
    process.stdout.write(`Already have ${outFile} (${(sz / 1e6).toFixed(1)} MB). Use --force to refresh.\n`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  // Overpass operators rotate; this is the canonical .de endpoint.
  const url = 'https://overpass-api.de/api/interpreter';
  process.stdout.write(`Fetching central Aalborg from ${url}\n`);
  process.stdout.write(`  bbox: ${SOUTH},${WEST},${NORTH},${EAST}\n`);
  const t0 = Date.now();
  // Overpass accepts the raw query as a POST body (the `data=` form is also
  // accepted but bare text is what `curl -X POST -d @file` produces).
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      Accept: 'application/xml, text/xml, */*',
      'User-Agent': 'openmaps-v2-test-fetcher/0.1',
    },
    body: query,
  });
  if (!res.ok) {
    throw new Error(`Overpass returned HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outFile, buf);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`Wrote ${outFile} (${(buf.length / 1e6).toFixed(1)} MB in ${dt}s)\n`);
}

main().catch((err) => {
  process.stderr.write(`fetch-aalborg failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
