import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import type { SyntheticData } from './synthetic.js';

/**
 * Builds an MBTiles file with vector tiles (MVT, gzipped) for the road
 * network and named places in the synthetic data. Tiles are generated for
 * z=8..14 inclusive — small enough to be fast to build, large enough to
 * span "country" to "street" zoom in a real region.
 *
 * MBTiles spec: https://github.com/mapbox/mbtiles-spec
 *   metadata(name, value)
 *   tiles(zoom_level, tile_column, tile_row, tile_data)  -- TMS y!
 */
const MIN_ZOOM = 8;
const MAX_ZOOM = 14;

export function writeMbtiles(outPath: string, data: SyntheticData, opts: { name: string; attribution: string }): void {
  const db = new DatabaseSync(outPath);
  try {
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;

      CREATE TABLE metadata (name TEXT, value TEXT);
      CREATE TABLE tiles (
        zoom_level INTEGER,
        tile_column INTEGER,
        tile_row INTEGER,
        tile_data BLOB,
        PRIMARY KEY (zoom_level, tile_column, tile_row)
      );
    `);

    const insertMeta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
    const [minLon, minLat, maxLon, maxLat] = data.bbox;
    const cx = (minLon + maxLon) / 2;
    const cy = (minLat + maxLat) / 2;
    const metaRows: ReadonlyArray<[string, string]> = [
      ['name', opts.name],
      ['format', 'pbf'],
      ['version', '1'],
      ['minzoom', String(MIN_ZOOM)],
      ['maxzoom', String(MAX_ZOOM)],
      ['bounds', data.bbox.join(',')],
      ['center', `${cx},${cy},${MIN_ZOOM}`],
      ['attribution', opts.attribution],
      [
        'json',
        JSON.stringify({
          vector_layers: [
            { id: 'water', minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM, fields: { name: 'String' } },
            { id: 'roads', minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM, fields: { name: 'String', ref: 'String', highway: 'String' } },
            { id: 'places', minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM, fields: { name: 'String', kind: 'String' } },
          ],
        }),
      ],
    ];
    for (const [k, v] of metaRows) insertMeta.run(k, v);

    // Build GeoJSON: roads as LineStrings, places as Points.
    //
    // CRITICAL: emit one LineString per OSM way (coalesced from the edges
    // that share a wayId) rather than one per edge. MapLibre's
    // `symbol-placement: line` needs continuous geometry to place a label
    // — when every edge is a 2-point fragment, even Algade in Aalborg
    // gets split into 30+ tiny pieces, and the label engine refuses to
    // render anything because no individual segment is long enough. This
    // also roughly halves tile bytes (no coordinate duplication at every
    // joint).
    //
    // Each OSM way contributed forward-direction edges (a→b) and possibly
    // reverse-direction edges (b→a). We rebuild the way's node chain from
    // the forward edges and ignore reverse duplicates, which is enough
    // for rendering purposes — reverse edges exist solely for the router.
    const nodesById = new Map(data.nodes.map((n) => [n.id, n]));
    interface WayInfo {
      readonly nodeRefs: number[];
      readonly name: string;
      readonly ref: string | undefined;
      readonly highway: string;
    }
    const wayByWayId = new Map<number, WayInfo>();
    // Per-way forward-edge map: fromNode → toNode (one entry per joint).
    // We reconstruct the chain by walking this map from the start node.
    const forwardEdgesByWayId = new Map<number, Map<number, number>>();
    for (const e of data.edges) {
      if (!wayByWayId.has(e.wayId)) {
        wayByWayId.set(e.wayId, { nodeRefs: [], name: e.roadName, ref: e.ref, highway: e.highway });
        forwardEdgesByWayId.set(e.wayId, new Map());
      }
      forwardEdgesByWayId.get(e.wayId)!.set(e.fromNode, e.toNode);
    }
    for (const [wayId, fwd] of forwardEdgesByWayId) {
      const info = wayByWayId.get(wayId)!;
      // Find a start node: one that appears as a `from` but never as a
      // `to`. Open ways have exactly one. Closed loops (rare for roads)
      // wrap around — fall back to any from-node.
      const toSet = new Set(fwd.values());
      let start: number | undefined;
      for (const fromId of fwd.keys()) {
        if (!toSet.has(fromId)) { start = fromId; break; }
      }
      if (start === undefined) {
        const firstKey = fwd.keys().next().value;
        if (firstKey === undefined) continue;
        start = firstKey;
      }
      // Walk forward edges to rebuild the chain. Cap walk length to guard
      // against accidental cycles.
      const chain: number[] = [start];
      let cur: number | undefined = start;
      const visited = new Set<number>([start]);
      while (cur !== undefined && chain.length < fwd.size + 1) {
        const next: number | undefined = fwd.get(cur);
        if (next === undefined || visited.has(next)) break;
        chain.push(next);
        visited.add(next);
        cur = next;
      }
      info.nodeRefs.push(...chain);
    }

    const roadFeatures: Array<{
      type: 'Feature';
      geometry: { type: 'LineString'; coordinates: number[][] };
      properties: { name: string; ref?: string; highway: string };
    }> = [];
    for (const info of wayByWayId.values()) {
      if (info.nodeRefs.length < 2) continue;
      const coordinates: number[][] = [];
      for (const nid of info.nodeRefs) {
        const n = nodesById.get(nid);
        if (!n) continue;
        coordinates.push([n.lon, n.lat]);
      }
      if (coordinates.length < 2) continue;
      const properties: { name: string; ref?: string; highway: string } = {
        name: info.name,
        highway: info.highway,
      };
      if (info.ref) properties.ref = info.ref;
      roadFeatures.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties,
      });
    }
    // Addresses live in `data.places` purely so the geocode FTS index can
    // find them — they're a search-only feature. Skip them here so a
    // building's house number doesn't become a map label and clutter
    // every street at zoom 14. The map still gets a marker for a chosen
    // address via the renderer's setMarker flow when the user picks one
    // from search results.
    const placeFeatures = data.places
      .filter((p) => p.kind !== 'address')
      .map((p) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        properties: { name: p.displayName, kind: p.kind },
      }));

    // Water polygons. Each polygon is encoded as a GeoJSON Polygon with a
    // single outer ring (no holes — see osmToPack comment on multi-polygons).
    const waterFeatures = (data.waters ?? []).map((w) => {
      const properties: { name?: string } = {};
      if (w.name) properties.name = w.name;
      // geojson-vt's type signature wants mutable arrays, but a shallow
      // clone is fine — we don't mutate the rings downstream.
      const ring: number[][] = w.ring.map(([lon, lat]) => [lon, lat]);
      return {
        type: 'Feature' as const,
        geometry: {
          type: 'Polygon' as const,
          coordinates: [ring],
        },
        properties,
      };
    });

    const roadsLayer = geojsonvt(
      { type: 'FeatureCollection', features: roadFeatures },
      { maxZoom: MAX_ZOOM, indexMaxZoom: MAX_ZOOM, tolerance: 0 },
    );
    const placesLayer = geojsonvt(
      { type: 'FeatureCollection', features: placeFeatures },
      { maxZoom: MAX_ZOOM, indexMaxZoom: MAX_ZOOM, tolerance: 0 },
    );
    // For water, allow geojson-vt to simplify at lower zooms — a 500-vertex
    // lake ring at z=8 looks the same as at z=14 to the eye but costs ~5x
    // more bytes. tolerance: 3 is a sane default ported from openmaptiles.
    const waterLayer = waterFeatures.length > 0
      ? geojsonvt(
          { type: 'FeatureCollection', features: waterFeatures },
          { maxZoom: MAX_ZOOM, indexMaxZoom: MAX_ZOOM, tolerance: 3 },
        )
      : null;

    const insertTile = db.prepare(
      'INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)',
    );

    db.exec('BEGIN');
    for (let z = MIN_ZOOM; z <= MAX_ZOOM; z += 1) {
      const tileRange = bboxToTileRange(data.bbox, z);
      for (let x = tileRange.minX; x <= tileRange.maxX; x += 1) {
        for (let y = tileRange.minY; y <= tileRange.maxY; y += 1) {
          const roadsTile = roadsLayer.getTile(z, x, y);
          const placesTile = placesLayer.getTile(z, x, y);
          const waterTile = waterLayer ? waterLayer.getTile(z, x, y) : null;
          if (!roadsTile && !placesTile && !waterTile) continue;
          const layers: Record<string, unknown> = {};
          // Water goes first so the MVT preserves the rendering order
          // hint — though MapLibre uses style-layer order, not tile-layer
          // order, this matches user expectation if a debugger inspects
          // the tile manually.
          if (waterTile) layers.water = waterTile;
          if (roadsTile) layers.roads = roadsTile;
          if (placesTile) layers.places = placesTile;
          const buf = vtpbf.fromGeojsonVt(layers as never);
          if (buf.length === 0) continue;
          const gz = gzipSync(buf);
          const tmsY = (1 << z) - 1 - y;
          insertTile.run(z, x, tmsY, gz);
        }
      }
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

function bboxToTileRange(
  bbox: [number, number, number, number],
  z: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const n = 1 << z;
  const lonToX = (lon: number): number => Math.floor(((lon + 180) / 360) * n);
  const latToY = (lat: number): number => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  return {
    minX: Math.max(0, lonToX(minLon)),
    maxX: Math.min(n - 1, lonToX(maxLon)),
    // Note: lower latitude = higher y in XYZ scheme.
    minY: Math.max(0, latToY(maxLat)),
    maxY: Math.min(n - 1, latToY(minLat)),
  };
}
