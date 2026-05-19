import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  GeocodeIndex,
  PlaceKind,
  ReverseOptions,
  ReverseResult,
  SearchOptions,
  SearchResult,
} from '@openmaps/core';

/**
 * Reads a geocode.sqlite produced by region-builder. Schema:
 *
 *   places(id, display_name, kind, lat, lon, country, admin_path)
 *   places_fts USING fts5(display_name, alt_names, admin_path, content='places')
 *   places_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon)
 *
 *   roads(id, name, kind)   -- kind ∈ {'street','road'}
 *   roads_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon)
 *
 * Forward search uses FTS5 with bm25 ranking, biased by distance to viewport
 * center when viewport is given.
 * Reverse uses R*Tree to fetch candidate features within a meters-bounded
 * bbox, then sorts by haversine distance.
 */
export class SqliteGeocodeIndex implements GeocodeIndex {
  private readonly db: DatabaseSync;
  private readonly searchStmt: StatementSync;
  private readonly reverseEdgesStmt: StatementSync;
  private readonly reversePlacesStmt: StatementSync;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath, { readOnly: true });
    this.db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');

    // FTS5 MATCH returns rowid; join back to places. Lower bm25 = better.
    this.searchStmt = this.db.prepare(`
      SELECT p.id AS id, p.display_name AS display_name, p.kind AS kind,
             p.lat AS lat, p.lon AS lon, p.country AS country,
             p.admin_path AS admin_path,
             bm25(places_fts) AS rank_score
      FROM places_fts
      JOIN places p ON p.rowid = places_fts.rowid
      WHERE places_fts MATCH ?
      ORDER BY rank_score
      LIMIT ?
    `);

    // Reverse query splits into two passes:
    //   1. Edges with both endpoints, so we can compute perpendicular-to-
    //      segment distance instead of bbox-center distance. The R*Tree
    //      bbox is expanded by the search radius before this query is run.
    //   2. Places (POIs/admin/place) with their point coordinates.
    this.reverseEdgesStmt = this.db.prepare(`
      SELECT CAST(e.id AS TEXT) AS id,
             e.road_name AS display_name,
             n1.lat AS lat1, n1.lon AS lon1,
             n2.lat AS lat2, n2.lon AS lon2
      FROM edges_rtree er
      JOIN edges e ON e.id = er.id
      JOIN nodes n1 ON n1.id = e.from_node
      JOIN nodes n2 ON n2.id = e.to_node
      WHERE er.max_lat >= ? AND er.min_lat <= ?
        AND er.max_lon >= ? AND er.min_lon <= ?
        AND e.road_name IS NOT NULL
    `);
    this.reversePlacesStmt = this.db.prepare(`
      SELECT p.id AS id, p.display_name AS display_name, p.kind AS kind,
             p.lat AS lat, p.lon AS lon
      FROM places_rtree pr JOIN places p ON p.rowid = pr.id
      WHERE pr.max_lat >= ? AND pr.min_lat <= ?
        AND pr.max_lon >= ? AND pr.min_lon <= ?
    `);
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const limit = Math.min(opts.limit ?? 10, 25);

    const tokens = trimmed
      .toLowerCase()
      .split(/[^a-z0-9æøåäöüéèàâ]+/i)
      .filter((t) => t.length > 0)
      .map((t) => escapeFts(t));
    if (tokens.length === 0) return [];
    const lastIdx = tokens.length - 1;
    tokens[lastIdx] = tokens[lastIdx] + '*';
    const ftsQuery = tokens.join(' AND ');

    type Row = {
      id: string;
      display_name: string;
      kind: PlaceKind;
      lat: number;
      lon: number;
      country: string;
      admin_path: string | null;
      rank_score: number;
    };
    let rows: Row[];
    try {
      rows = this.searchStmt.all(ftsQuery, limit * 3) as unknown as Row[];
    } catch {
      return [];
    }

    const bias =
      opts.viewport != null
        ? (() => {
            const [minLon, minLat, maxLon, maxLat] = opts.viewport!;
            const cx = (minLon + maxLon) / 2;
            const cy = (minLat + maxLat) / 2;
            return (lat: number, lon: number) => {
              const dx = lon - cx;
              const dy = lat - cy;
              return Math.sqrt(dx * dx + dy * dy);
            };
          })()
        : null;

    const scored = rows
      .filter((r) => !opts.kind || r.kind === opts.kind)
      .map((r) => {
        const dist = bias ? bias(r.lat, r.lon) : 0;
        const composite = -r.rank_score - dist * 0.5;
        return { row: r, composite };
      })
      .sort((a, b) => b.composite - a.composite)
      .slice(0, limit);

    const maxScore = scored[0]?.composite ?? 1;
    return scored.map(({ row, composite }) => ({
      id: row.id,
      displayName: row.display_name,
      kind: row.kind,
      lat: row.lat,
      lon: row.lon,
      country: row.country,
      ...(row.admin_path ? { adminPath: row.admin_path } : {}),
      score: maxScore > 0 ? composite / maxScore : 0,
    }));
  }

  async reverse(lat: number, lon: number, opts: ReverseOptions = {}): Promise<ReverseResult | null> {
    const maxR = opts.maxRadiusM ?? 100;
    const preferRoads = opts.preferRoads ?? true;
    const dLat = maxR / 111_320;
    const dLon = maxR / (111_320 * Math.cos((lat * Math.PI) / 180));

    type EdgeRow = {
      id: string;
      display_name: string;
      lat1: number;
      lon1: number;
      lat2: number;
      lon2: number;
    };
    type PlaceRow = {
      id: string;
      display_name: string;
      kind: PlaceKind;
      lat: number;
      lon: number;
    };

    const edgeRows = this.reverseEdgesStmt.all(
      lat - dLat,
      lat + dLat,
      lon - dLon,
      lon + dLon,
    ) as unknown as ReadonlyArray<EdgeRow>;
    const placeRows = this.reversePlacesStmt.all(
      lat - dLat,
      lat + dLat,
      lon - dLon,
      lon + dLon,
    ) as unknown as ReadonlyArray<PlaceRow>;

    type Candidate = {
      source: 'road' | 'place';
      displayName: string;
      kind: PlaceKind;
      distM: number;
    };
    const candidates: Candidate[] = [];

    for (const e of edgeRows) {
      const d = pointToSegmentMeters(lat, lon, e.lat1, e.lon1, e.lat2, e.lon2);
      if (d <= maxR) {
        candidates.push({ source: 'road', displayName: e.display_name, kind: 'street', distM: d });
      }
    }
    for (const p of placeRows) {
      const d = haversineMeters(lat, lon, p.lat, p.lon);
      if (d <= maxR) {
        candidates.push({ source: 'place', displayName: p.display_name, kind: p.kind, distM: d });
      }
    }

    if (candidates.length === 0) return null;

    // Score: distance + a small boost away from the non-preferred source. We
    // don't strictly prefer roads when a place sits exactly at the query
    // point — the boost only matters when distances are within ~30m of each
    // other.
    const scored = candidates
      .map((c) => {
        const sourceBoost = preferRoads
          ? c.source === 'road'
            ? 0
            : 30
          : c.source === 'place'
            ? 0
            : 30;
        return { ...c, score: c.distM + sourceBoost };
      })
      .sort((a, b) => a.score - b.score);

    const best = scored[0]!;
    return {
      displayName: best.displayName,
      kind: best.kind,
      distanceM: Math.round(best.distM),
      ...(best.source === 'road' ? { road: best.displayName } : {}),
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function escapeFts(token: string): string {
  if (/^[a-z0-9æøåäöüéèàâ]+$/i.test(token)) return token;
  return `"${token.replaceAll('"', '""')}"`;
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

/**
 * Distance from point P to segment AB, in meters. Uses an equirectangular
 * projection around P's latitude (cos(lat) scaling for longitude) — accurate
 * to a fraction of a percent for the distances we reverse-geocode at (<1km).
 *
 * Algorithm: project AB and AP into a local (x = lon·cosLat, y = lat) frame,
 * find the closest point on AB, then convert the residual back to meters via
 * haversine using that foot-of-perpendicular.
 */
function pointToSegmentMeters(
  pLat: number,
  pLon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const cosLat = Math.cos((pLat * Math.PI) / 180);
  const ax = aLon * cosLat;
  const ay = aLat;
  const bx = bLon * cosLat;
  const by = bLat;
  const px = pLon * cosLat;
  const py = pLat;

  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return haversineMeters(pLat, pLon, aLat, aLon);

  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;

  const footLon = aLon + t * (bLon - aLon);
  const footLat = aLat + t * (bLat - aLat);
  return haversineMeters(pLat, pLon, footLat, footLon);
}
