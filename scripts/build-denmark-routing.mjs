#!/usr/bin/env node
/**
 * Build a country-wide routing companion database from the already-verified
 * overlapping Denmark packs. Regional geocode databases retain OSM node IDs,
 * so merging their road graphs produces one continuous graph at region edges
 * without guessing where a route should leave a subpack.
 *
 * This intentionally contains a car-routing backbone (40 km/h+ by default):
 * tiles, search indexes, addresses, building geometry, and local-only
 * walking/cycling edges remain in regional packs. Keeping the country
 * companion compact makes a browser download and a country-scale query
 * practical while retaining detailed bike/foot routing within packs.
 *
 * Usage:
 *   node scripts/build-denmark-routing.mjs
 *   node scripts/build-denmark-routing.mjs --out routing/denmark-routing.sqlite
 *   node scripts/build-denmark-routing.mjs --min-speed 0 # exhaustive car graph
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const outPath = resolve(root, flagValue('--out') ?? 'routing/denmark-routing.sqlite');
const minSpeed = Number(flagValue('--min-speed') ?? '40');
if (!Number.isFinite(minSpeed) || minSpeed < 0) throw new Error('--min-speed must be a non-negative number');
const collection = JSON.parse(await BunOrNodeRead(resolve(root, 'config/denmark-collection.json')));

mkdirSync(dirname(outPath), { recursive: true });
if (existsSync(outPath)) rmSync(outPath);

const db = new DatabaseSync(outPath);
try {
  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;

    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      lat REAL NOT NULL,
      lon REAL NOT NULL
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY,
      from_node INTEGER NOT NULL,
      to_node INTEGER NOT NULL,
      length_m REAL NOT NULL,
      max_speed_kmh REAL NOT NULL,
      allows_car INTEGER NOT NULL,
      allows_bike INTEGER NOT NULL,
      allows_foot INTEGER NOT NULL,
      road_name TEXT,
      way_id INTEGER,
      UNIQUE(from_node, to_node, way_id)
    );
    CREATE INDEX edges_from ON edges(from_node);
  `);

  for (const id of collection.members) {
    const source = resolve(root, 'packs', id, 'geocode.sqlite');
    if (!existsSync(source)) throw new Error(`missing verified Denmark pack database: ${id}`);
    const quoted = source.replaceAll("'", "''");
    process.stdout.write(`  - merging ${id}\n`);
    db.exec(`ATTACH DATABASE '${quoted}' AS source;`);
    db.exec(`
      INSERT OR IGNORE INTO nodes (id, lat, lon)
      SELECT n.id, n.lat, n.lon
      FROM source.nodes n JOIN source.edges e ON e.from_node = n.id
      WHERE e.allows_car = 1 AND e.max_speed_kmh >= ${minSpeed};
      INSERT OR IGNORE INTO nodes (id, lat, lon)
      SELECT n.id, n.lat, n.lon
      FROM source.nodes n JOIN source.edges e ON e.to_node = n.id
      WHERE e.allows_car = 1 AND e.max_speed_kmh >= ${minSpeed};
      INSERT OR IGNORE INTO edges (
        from_node, to_node, length_m, max_speed_kmh,
        allows_car, allows_bike, allows_foot, road_name, way_id
      )
      SELECT from_node, to_node, length_m, max_speed_kmh,
             allows_car, allows_bike, allows_foot, road_name, way_id
      FROM source.edges
      WHERE allows_car = 1 AND max_speed_kmh >= ${minSpeed};
    `);
    db.exec('DETACH DATABASE source;');
  }

  process.stdout.write('  - building spatial snap index\n');
  db.exec(`
    CREATE VIRTUAL TABLE nodes_rtree USING rtree(
      id, min_lat, max_lat, min_lon, max_lon
    );
    INSERT INTO nodes_rtree (id, min_lat, max_lat, min_lon, max_lon)
    SELECT id, lat, lat, lon, lon FROM nodes;
    ANALYZE;
  `);
  const counts = db.prepare('SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges').get();
  process.stdout.write(`  - ${counts.nodes} nodes, ${counts.edges} edges\n`);
} finally {
  db.close();
}

const bytes = statSync(outPath).size;
const sha256 = createHash('sha256').update(await BunOrNodeReadBuffer(outPath)).digest('hex');
const descriptor = {
  id: 'denmark-routing',
  name: 'Denmark national driving backbone',
  country: 'DK',
  bbox: collection.bbox,
  file: { path: 'denmark-routing.sqlite', bytes, sha256 },
  profiles: ['car'],
  description: `Car-routing backbone for cross-region Denmark routes (${minSpeed} km/h+ roads). Requires regional map packs for map display and local search.`,
};
const descriptorPath = resolve(dirname(outPath), 'denmark-routing.json');
writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
process.stdout.write(`Done. ${Math.round(bytes / 1024 / 1024)} MB routing graph: ${outPath}\n`);

async function BunOrNodeRead(path) {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

async function BunOrNodeReadBuffer(path) {
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}
