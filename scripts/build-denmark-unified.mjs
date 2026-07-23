#!/usr/bin/env node
/**
 * Build one Denmark SQLite pack from the verified overlapping regional packs.
 *
 * This deliberately operates in SQLite instead of re-reading the country PBF:
 * the PBF has >53m nodes and exceeds V8's Map size before the builder can
 * process it. Regional packs already preserve original OSM node ids, so
 * merging their tables retains cross-region graph connectivity.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packsDir = join(root, 'packs');
const collection = JSON.parse(await readFile(join(root, 'config', 'denmark-collection.json'), 'utf8'));
const memberIds = collection.members;
const targetDir = join(packsDir, 'denmark');
const stagingDir = join(packsDir, `.staging-denmark-build-${process.pid}`);
const targetDb = join(stagingDir, 'openmaps.sqlite');

for (const id of memberIds) {
  for (const file of ['manifest.json', 'tiles.mbtiles', 'geocode.sqlite']) {
    await stat(join(packsDir, id, file));
  }
}

// Keep the last verified country pack intact until the replacement is fully
// built and closed. A failed merge must never destroy the usable artifact.
await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });
await copyFile(join(packsDir, memberIds[0], 'geocode.sqlite'), targetDb);

const db = new DatabaseSync(targetDb);
try {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;
    DROP TABLE places_fts;
    DELETE FROM places_rtree;
    DELETE FROM parcels;
    DELETE FROM places;
    DELETE FROM edges_rtree;
    DELETE FROM edges;
    DELETE FROM nodes_rtree;
    DELETE FROM nodes;
    CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE tiles (
      zoom_level INTEGER,
      tile_column INTEGER,
      tile_row INTEGER,
      tile_data BLOB,
      PRIMARY KEY (zoom_level, tile_column, tile_row)
    );
    -- Regional packs overlap. This natural key removes duplicate directed
    -- OSM segments while retaining distinct access/speed variants.
    CREATE UNIQUE INDEX edges_natural_unique ON edges(
      from_node, to_node, way_id, allows_car, allows_bike, allows_foot,
      max_speed_kmh, COALESCE(road_name, '')
    );
  `);

  for (const [i, id] of memberIds.entries()) {
    const geo = join(packsDir, id, 'geocode.sqlite');
    const tiles = join(packsDir, id, 'tiles.mbtiles');
    process.stdout.write(`Merging ${i + 1}/${memberIds.length}: ${id}\n`);
    db.exec(`
      ATTACH DATABASE ${sql(geo)} AS source_geo;
      ATTACH DATABASE ${sql(tiles)} AS source_tiles;
      BEGIN IMMEDIATE;
      INSERT OR IGNORE INTO places (id, display_name, kind, lat, lon, country, admin_path, parcel_id)
        SELECT id, display_name, kind, lat, lon, country, admin_path, parcel_id FROM source_geo.places;
      INSERT OR IGNORE INTO parcels (id, label, ejerlavkode, ejerlavnavn, matrikelnr, rings_json)
        SELECT id, label, ejerlavkode, ejerlavnavn, matrikelnr, rings_json FROM source_geo.parcels;
      INSERT OR IGNORE INTO nodes (id, lat, lon)
        SELECT id, lat, lon FROM source_geo.nodes;
      INSERT OR IGNORE INTO edges (from_node, to_node, length_m, max_speed_kmh, allows_car, allows_bike, allows_foot, road_name, way_id)
        SELECT from_node, to_node, length_m, max_speed_kmh, allows_car, allows_bike, allows_foot, road_name, way_id
        FROM source_geo.edges;
      INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data)
        SELECT zoom_level, tile_column, tile_row, tile_data FROM source_tiles.tiles;
      ${i === 0 ? 'INSERT INTO metadata SELECT name, value FROM source_tiles.metadata;' : ''}
      COMMIT;
      DETACH DATABASE source_geo;
      DETACH DATABASE source_tiles;
    `);
  }

  process.stdout.write('Rebuilding search and spatial indexes…\n');
  const [minLon, minLat, maxLon, maxLat] = collection.bbox;
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  db.exec(`
    CREATE VIRTUAL TABLE places_fts USING fts5(
      display_name, alt_names, admin_path,
      content='places', content_rowid='rowid'
    );
    INSERT INTO places_fts (rowid, display_name, alt_names, admin_path)
      SELECT rowid, display_name, '', COALESCE(admin_path, '') FROM places;
    INSERT INTO places_rtree (id, min_lat, max_lat, min_lon, max_lon)
      SELECT rowid, lat, lat, lon, lon FROM places;
    INSERT INTO nodes_rtree (id, min_lat, max_lat, min_lon, max_lon)
      SELECT id, lat, lat, lon, lon FROM nodes;
    INSERT INTO edges_rtree (id, min_lat, max_lat, min_lon, max_lon)
      SELECT e.id, MIN(n1.lat, n2.lat), MAX(n1.lat, n2.lat), MIN(n1.lon, n2.lon), MAX(n1.lon, n2.lon)
      FROM edges e JOIN nodes n1 ON n1.id = e.from_node JOIN nodes n2 ON n2.id = e.to_node
      GROUP BY e.id;
    CREATE INDEX edges_from_profile ON edges(from_node, allows_car, allows_bike, allows_foot);
    DELETE FROM metadata WHERE name IN ('name', 'description', 'bounds', 'center');
    INSERT INTO metadata (name, value) VALUES
      ('name', 'Denmark'),
      ('description', 'OpenMaps unified Denmark pack'),
      ('bounds', ${sql(collection.bbox.join(','))}),
      ('center', ${sql(`${centerLon},${centerLat},7`)});
    ANALYZE;
    VACUUM;
  `);

  const sample = db.prepare('SELECT zoom_level, tile_column, tile_row FROM tiles ORDER BY zoom_level, tile_column, tile_row LIMIT 1').get();
  if (!sample) throw new Error('merged database contains no tiles');
  const file = await packFile(targetDb);
  const z = Number(sample.zoom_level);
  const manifest = {
    schemaVersion: 2,
    id: 'denmark',
    name: 'Denmark',
    country: 'DK',
    bbox: collection.bbox,
    builtAt: new Date().toISOString(),
    builderCommit: resolveBuilderCommit(),
    files: { tiles: file, geocode: file, routing: file, database: file },
    selfTestAnchors: {
      searchTerms: ['Aarhus', 'København'],
      reversePoint: { lat: 56.15, lon: 10.21 },
      routeWaypoints: [{ lat: 55.6761, lon: 12.5683 }, { lat: 56.1629, lon: 10.2039 }],
      tileSample: { z, x: Number(sample.tile_column), y: (1 << z) - 1 - Number(sample.tile_row) },
    },
  };
  await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
} finally {
  db.close();
}

await promotePack(stagingDir, targetDir);
process.stdout.write(`Done: ${join(targetDir, 'openmaps.sqlite')}\n`);

function sql(path) { return `'${path.replaceAll("'", "''")}'`; }
async function packFile(path) {
  const info = await stat(path);
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
  });
  return { path: 'openmaps.sqlite', bytes: info.size, sha256: hash.digest('hex') };
}

function resolveBuilderCommit() {
  if (process.env.GIT_COMMIT && /^[0-9a-f]{7,40}$/i.test(process.env.GIT_COMMIT)) {
    return process.env.GIT_COMMIT.toLowerCase();
  }
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim().toLowerCase();
}

async function promotePack(staged, live) {
  const backup = `${live}.old-${process.pid}`;
  await rm(backup, { recursive: true, force: true });
  let movedLive = false;
  try {
    try {
      await rename(live, backup);
      movedLive = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(staged, live);
    if (movedLive) {
      try {
        await rm(backup, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(`WARN: promoted pack is live, but old backup cleanup failed: ${error.message}\n`);
      }
    }
  } catch (error) {
    // If promotion fails after moving the old pack aside, restore it. Leave
    // the staged build available for diagnosis when restoration is possible.
    try {
      await stat(live);
    } catch {
      if (movedLive) await rename(backup, live);
    }
    throw error;
  }
}
