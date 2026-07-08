import type {
  GeocodeIndex,
  Parcel,
  PlaceKind,
  ReverseOptions,
  ReverseResult,
  SearchOptions,
  SearchResult,
} from '@openmaps/core';
import type { WebDb, Stmt } from './sqlite.js';

/**
 * Browser port of packages/platform-node/src/SqliteGeocodeIndex.ts. The
 * tokenizer, scoring, and reverse-geocoding algorithm are unchanged; only
 * the SQLite handle differs.
 */
export class WebGeocodeIndex implements GeocodeIndex {
  private readonly db: WebDb;
  private readonly searchStmt: Stmt;
  private readonly reverseEdgesStmt: Stmt;
  private readonly reversePlacesStmt: Stmt;
  private readonly parcelStmt: Stmt | null;
  private readonly hasParcelIdColumn: boolean;

  constructor(db: WebDb) {
    this.db = db;
    // Older packs (pre-DAWA) lack the parcel_id column and the parcels
    // table entirely. Detect and degrade gracefully so we can still read
    // them as plain geocode indexes.
    this.hasParcelIdColumn = placesHasColumn(db, 'parcel_id');
    this.searchStmt = db.prepare(
      this.hasParcelIdColumn
        ? `
      SELECT p.id AS id, p.display_name AS display_name, p.kind AS kind,
             p.lat AS lat, p.lon AS lon, p.country AS country,
             p.admin_path AS admin_path, p.parcel_id AS parcel_id,
             bm25(places_fts) AS rank_score
      FROM places_fts
      JOIN places p ON p.rowid = places_fts.rowid
      WHERE places_fts MATCH ?
      ORDER BY rank_score
      LIMIT ?
    `
        : `
      SELECT p.id AS id, p.display_name AS display_name, p.kind AS kind,
             p.lat AS lat, p.lon AS lon, p.country AS country,
             p.admin_path AS admin_path, NULL AS parcel_id,
             bm25(places_fts) AS rank_score
      FROM places_fts
      JOIN places p ON p.rowid = places_fts.rowid
      WHERE places_fts MATCH ?
      ORDER BY rank_score
      LIMIT ?
    `,
    );
    this.parcelStmt = parcelsTableExists(db)
      ? db.prepare(`
          SELECT id, label, ejerlavkode, ejerlavnavn, matrikelnr, rings_json
          FROM parcels WHERE id = ?
        `)
      : null;

    this.reverseEdgesStmt = db.prepare(`
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
    this.reversePlacesStmt = db.prepare(`
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

    let rows: ReturnType<Stmt['all']>;
    try {
      rows = this.searchStmt.all(ftsQuery, limit * 3);
    } catch {
      return [];
    }

    const bias =
      opts.viewport != null
        ? (() => {
            const [minLon, minLat, maxLon, maxLat] = opts.viewport!;
            const cx = (minLon + maxLon) / 2;
            const cy = (minLat + maxLat) / 2;
            return (lat: number, lon: number): number => {
              const dx = lon - cx;
              const dy = lat - cy;
              return Math.sqrt(dx * dx + dy * dy);
            };
          })()
        : null;

    const scored = rows
      .map((r) => ({
        id: String(r['id']),
        displayName: String(r['display_name']),
        kind: String(r['kind']) as PlaceKind,
        lat: Number(r['lat']),
        lon: Number(r['lon']),
        country: String(r['country']),
        adminPath: r['admin_path'] != null ? String(r['admin_path']) : null,
        parcelId: r['parcel_id'] != null ? String(r['parcel_id']) : null,
        rankScore: Number(r['rank_score']),
      }))
      .filter((r) => !opts.kind || r.kind === opts.kind)
      .map((r) => {
        const dist = bias ? bias(r.lat, r.lon) : 0;
        const composite = -r.rankScore - dist * 0.5;
        return { row: r, composite };
      })
      .sort((a, b) => b.composite - a.composite)
      .slice(0, limit);

    const maxScore = scored[0]?.composite ?? 1;
    return scored.map(({ row, composite }) => ({
      id: row.id,
      displayName: row.displayName,
      kind: row.kind,
      lat: row.lat,
      lon: row.lon,
      country: row.country,
      ...(row.adminPath ? { adminPath: row.adminPath } : {}),
      ...(row.parcelId ? { parcelId: row.parcelId } : {}),
      score: maxScore > 0 ? composite / maxScore : 0,
    }));
  }

  async getParcel(parcelId: string): Promise<Parcel | null> {
    if (!this.parcelStmt) return null;
    let rows: ReturnType<Stmt['all']>;
    try {
      rows = this.parcelStmt.all(parcelId);
    } catch {
      return null;
    }
    const r = rows[0];
    if (!r) return null;
    let rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
    try {
      rings = JSON.parse(String(r['rings_json'])) as ReadonlyArray<
        ReadonlyArray<readonly [number, number]>
      >;
    } catch {
      return null;
    }
    return {
      id: String(r['id']),
      label: String(r['label']),
      ejerlavkode: r['ejerlavkode'] != null ? Number(r['ejerlavkode']) : null,
      ejerlavnavn: r['ejerlavnavn'] != null ? String(r['ejerlavnavn']) : null,
      matrikelnr: r['matrikelnr'] != null ? String(r['matrikelnr']) : null,
      rings,
    };
  }

  async reverse(lat: number, lon: number, opts: ReverseOptions = {}): Promise<ReverseResult | null> {
    const maxR = opts.maxRadiusM ?? 100;
    const preferRoads = opts.preferRoads ?? true;
    const dLat = maxR / 111_320;
    const dLon = maxR / (111_320 * Math.cos((lat * Math.PI) / 180));

    const edgeRows = this.reverseEdgesStmt.all(lat - dLat, lat + dLat, lon - dLon, lon + dLon);
    const placeRows = this.reversePlacesStmt.all(lat - dLat, lat + dLat, lon - dLon, lon + dLon);

    type Candidate = {
      source: 'road' | 'place';
      displayName: string;
      kind: PlaceKind;
      distM: number;
    };
    const candidates: Candidate[] = [];

    for (const e of edgeRows) {
      const d = pointToSegmentMeters(
        lat,
        lon,
        Number(e['lat1']),
        Number(e['lon1']),
        Number(e['lat2']),
        Number(e['lon2']),
      );
      if (d <= maxR) {
        candidates.push({
          source: 'road',
          displayName: String(e['display_name']),
          kind: 'street',
          distM: d,
        });
      }
    }
    for (const p of placeRows) {
      const d = haversineMeters(lat, lon, Number(p['lat']), Number(p['lon']));
      if (d <= maxR) {
        candidates.push({
          source: 'place',
          displayName: String(p['display_name']),
          kind: String(p['kind']) as PlaceKind,
          distM: d,
        });
      }
    }

    if (candidates.length === 0) return null;

    // Three-tier kind preference. With preferRoads=true (default, used by
    // the click-to-inspect popup) we want road context first ("you're near
    // Strandvejen"). With preferRoads=false (used by route-waypoint lookups)
    // we want the most specific destination — an address-kind place beats a
    // road by 15 m, and a generic place (POI/admin/city) is still ranked
    // below the road. The numbers are small enough that a much closer
    // candidate still wins.
    const scored = candidates
      .map((c) => {
        let kindBoost: number;
        if (preferRoads) {
          kindBoost = c.source === 'road' ? 0 : c.kind === 'address' ? 15 : 30;
        } else {
          kindBoost =
            c.kind === 'address' ? 0 : c.source === 'road' ? 15 : 30;
        }
        return { ...c, score: c.distM + kindBoost };
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
    // The DB is owned by the pack loader (shared with the router), not us.
  }
}

function placesHasColumn(db: WebDb, name: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(places)`).all();
    return rows.some((r) => String(r['name']) === name);
  } catch {
    return false;
  }
}

function parcelsTableExists(db: WebDb): boolean {
  try {
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='parcels'`)
      .all();
    return rows.length > 0;
  } catch {
    return false;
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
