import { DatabaseSync } from 'node:sqlite';
import type { SyntheticData } from './synthetic.js';

/**
 * Writes geocode.sqlite. The same file contains the road graph (used by
 * InternalRouter). Layout:
 *
 *   places(rowid, id TEXT, display_name, kind, lat, lon, country, admin_path)
 *   places_fts(USING fts5, content='places', content_rowid='rowid')
 *   places_rtree(USING rtree)
 *
 *   roads(id, name, kind)
 *   roads_rtree(USING rtree)
 *
 *   nodes(id, lat, lon)
 *   nodes_rtree(USING rtree)
 *   edges(id, from_node, to_node, length_m, max_speed_kmh, allows_*, road_name, way_id)
 *
 * After populating, runs ANALYZE so query planner has stats. The file is
 * written to /<outPath> and replaces any existing file.
 */
export function writeGeocodeDb(outPath: string, data: SyntheticData): void {
  const db = new DatabaseSync(outPath);
  try {
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;

      CREATE TABLE places (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        country TEXT NOT NULL,
        admin_path TEXT,
        parcel_id TEXT
      );

      CREATE TABLE parcels (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        ejerlavkode INTEGER,
        ejerlavnavn TEXT,
        matrikelnr TEXT,
        rings_json TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE places_fts USING fts5(
        display_name, alt_names, admin_path,
        content='places',
        content_rowid='rowid'
      );

      CREATE VIRTUAL TABLE places_rtree USING rtree(
        id, min_lat, max_lat, min_lon, max_lon
      );

      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY,
        lat REAL NOT NULL,
        lon REAL NOT NULL
      );
      CREATE VIRTUAL TABLE nodes_rtree USING rtree(
        id, min_lat, max_lat, min_lon, max_lon
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
        way_id INTEGER
      );
      CREATE INDEX edges_from ON edges(from_node);

      CREATE VIRTUAL TABLE edges_rtree USING rtree(
        id, min_lat, max_lat, min_lon, max_lon
      );
    `);

    db.exec('BEGIN');

    const insertPlace = db.prepare(`
      INSERT INTO places (id, display_name, kind, lat, lon, country, admin_path, parcel_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPlaceFts = db.prepare(`
      INSERT INTO places_fts (rowid, display_name, alt_names, admin_path)
      VALUES (?, ?, ?, ?)
    `);
    const insertPlaceRtree = db.prepare(`
      INSERT INTO places_rtree (id, min_lat, max_lat, min_lon, max_lon)
      VALUES (?, ?, ?, ?, ?)
    `);

    // SQLite rowid auto-increments starting at 1 for the first INSERT.
    // We track it manually to feed into FTS and R*Tree which need numeric ids.
    let placeRowid = 0;
    const placeRowidByStringId = new Map<string, number>();
    for (const p of data.places) {
      placeRowid += 1;
      insertPlace.run(
        p.id,
        p.displayName,
        p.kind,
        p.lat,
        p.lon,
        p.country,
        p.adminPath,
        p.parcelId ?? null,
      );
      insertPlaceFts.run(placeRowid, p.displayName, p.altNames ?? '', p.adminPath ?? '');
      insertPlaceRtree.run(placeRowid, p.lat, p.lat, p.lon, p.lon);
      placeRowidByStringId.set(p.id, placeRowid);
    }

    if (data.parcels && data.parcels.length > 0) {
      const insertParcel = db.prepare(`
        INSERT INTO parcels (id, label, ejerlavkode, ejerlavnavn, matrikelnr, rings_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const parcel of data.parcels) {
        insertParcel.run(
          parcel.id,
          parcel.label,
          parcel.ejerlavkode,
          parcel.ejerlavnavn,
          parcel.matrikelnr,
          JSON.stringify(parcel.rings),
        );
      }
    }

    const insertNode = db.prepare('INSERT INTO nodes (id, lat, lon) VALUES (?, ?, ?)');
    const insertNodeRtree = db.prepare(
      'INSERT INTO nodes_rtree (id, min_lat, max_lat, min_lon, max_lon) VALUES (?, ?, ?, ?, ?)',
    );
    for (const n of data.nodes) {
      insertNode.run(n.id, n.lat, n.lon);
      insertNodeRtree.run(n.id, n.lat, n.lat, n.lon, n.lon);
    }

    // Each edge gets its own row in edges_rtree (a small bbox between two
    // adjacent nodes). Reverse geocoding finds the nearest edge and reports
    // its road_name, which is much more accurate than using an aggregated
    // road bbox center.
    //
    // Road names are ALSO added to the places table (kind='street') so
    // forward search can find streets by name. We use the centroid of all
    // edges with that name as the place's lat/lon, just for display purposes.
    const insertEdge = db.prepare(`
      INSERT INTO edges (id, from_node, to_node, length_m, max_speed_kmh,
        allows_car, allows_bike, allows_foot, road_name, way_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdgeRtree = db.prepare(
      'INSERT INTO edges_rtree (id, min_lat, max_lat, min_lon, max_lon) VALUES (?, ?, ?, ?, ?)',
    );
    const nodesById = new Map(data.nodes.map((n) => [n.id, n]));

    const roadCentroid = new Map<string, { sumLat: number; sumLon: number; n: number }>();

    let edgeId = 0;
    for (const e of data.edges) {
      edgeId += 1;
      const from = nodesById.get(e.fromNode);
      const to = nodesById.get(e.toNode);
      if (!from || !to) throw new Error(`edge references missing node: ${e.fromNode}->${e.toNode}`);
      const len = haversineMeters(from.lat, from.lon, to.lat, to.lon);
      insertEdge.run(
        edgeId,
        e.fromNode,
        e.toNode,
        len,
        e.maxSpeedKmh,
        e.allowsCar ? 1 : 0,
        e.allowsBike ? 1 : 0,
        e.allowsFoot ? 1 : 0,
        e.roadName,
        e.wayId,
      );
      insertEdgeRtree.run(
        edgeId,
        Math.min(from.lat, to.lat),
        Math.max(from.lat, to.lat),
        Math.min(from.lon, to.lon),
        Math.max(from.lon, to.lon),
      );

      const c = roadCentroid.get(e.roadName);
      const midLat = (from.lat + to.lat) / 2;
      const midLon = (from.lon + to.lon) / 2;
      if (!c) {
        roadCentroid.set(e.roadName, { sumLat: midLat, sumLon: midLon, n: 1 });
      } else {
        c.sumLat += midLat;
        c.sumLon += midLon;
        c.n += 1;
      }
    }

    // Add a "street" place for each unique road name so forward search can
    // find streets too. Preserve the complete name in an encoded ID: a
    // lowercased/hyphenated slug can make distinct OSM spellings collide
    // (for example case-only or whitespace-only variants in real extracts).
    for (const [name, c] of roadCentroid) {
      placeRowid += 1;
      const id = `street:${encodeURIComponent(name)}`;
      const lat = c.sumLat / c.n;
      const lon = c.sumLon / c.n;
      insertPlace.run(id, name, 'street', lat, lon, 'XX', null);
      insertPlaceFts.run(placeRowid, name, '', '');
      insertPlaceRtree.run(placeRowid, lat, lat, lon, lon);
    }

    db.exec('COMMIT');
    db.exec('ANALYZE');
  } finally {
    db.close();
  }
}

function haversineMeters(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6371000;
  const dLat = ((la2 - la1) * Math.PI) / 180;
  const dLon = ((lo2 - lo1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
