// Snaps address-kind places onto building-footprint centroids when the
// address coordinate falls inside (or very close to) a building outline.
// Addresses are commonly stamped at the road-entry "adgangspunkt" rather
// than on the building itself, which is the right thing for routing-to
// but the wrong thing for showing on a map — users expect the pin on
// the house, like Google does. Snapping fixes that.
//
// Lookup is grid-indexed so the pass is linear in `addresses + buildings`,
// not quadratic — important when a city pack has tens of thousands of
// each.

import type { BuildingPolygon, PlaceFeature, SyntheticData } from './synthetic.js';

/**
 * Buffer (in degrees) used to extend the bbox of each building when
 * filtering candidates. ~0.0001° ≈ 11 m, which covers the typical offset
 * between an OSM/DAWA address node and the front of the building.
 *
 * If the address falls in the bbox after buffering AND inside (or very
 * near) the polygon's ring, we snap. The "very near" part uses the same
 * buffer to handle addresses placed at the property line.
 */
const BUFFER_DEG = 0.00012;

/**
 * Cell size for the spatial grid. 0.005° is ~350 m east-west at 57°N
 * and ~550 m north-south, which produces ~500–2000 cells for a city
 * pack — small enough that per-cell building lists stay short, large
 * enough that most addresses only need to look in 1-2 neighbours.
 */
const CELL_SIZE_DEG = 0.005;

interface BuildingIndex {
  /** Stable index into the indexedBuildings array, used as a snap-target key. */
  key: number;
  centroid: readonly [number, number];
  bbox: readonly [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  ring: ReadonlyArray<readonly [number, number]>;
}

export interface SnapResult {
  /** New SyntheticData with addresses possibly relocated to building centroids. */
  data: SyntheticData;
  /** Number of address-kind places that were snapped. Useful for build logs. */
  snapped: number;
}

/**
 * Returns a new SyntheticData with address-kind places snapped to their
 * containing building's centroid (if any). Non-address places and the
 * rest of the pack are passed through unchanged.
 *
 * No-op when `data.buildings` is empty/undefined.
 */
export function snapAddressesToBuildings(data: SyntheticData): SnapResult {
  const buildings = data.buildings;
  if (!buildings || buildings.length === 0) return { data, snapped: 0 };

  // Build per-cell candidate lists. A building lives in every cell that
  // its buffered bbox overlaps — usually just 1, occasionally 2-4 for
  // large structures (factories, malls, fjord-spanning bridges).
  const grid = new Map<string, BuildingIndex[]>();
  const indexedBuildings: BuildingIndex[] = [];
  for (const b of buildings) {
    const idx = indexBuilding(b, indexedBuildings.length);
    if (!idx) continue;
    indexedBuildings.push(idx);
    const [minLon, minLat, maxLon, maxLat] = idx.bbox;
    const c0x = Math.floor((minLon - BUFFER_DEG) / CELL_SIZE_DEG);
    const c1x = Math.floor((maxLon + BUFFER_DEG) / CELL_SIZE_DEG);
    const c0y = Math.floor((minLat - BUFFER_DEG) / CELL_SIZE_DEG);
    const c1y = Math.floor((maxLat + BUFFER_DEG) / CELL_SIZE_DEG);
    for (let cx = c0x; cx <= c1x; cx += 1) {
      for (let cy = c0y; cy <= c1y; cy += 1) {
        const key = `${cx},${cy}`;
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(idx);
      }
    }
  }
  if (indexedBuildings.length === 0) return { data, snapped: 0 };

  // Two-pass approach. We first resolve each address to its containing
  // building (if any), then count how many *distinct* addresses landed in
  // each building. Only addresses with a unique building target actually
  // get snapped — anything ambiguous (multi-unit footprint, an oversized
  // OSM polygon that swallows neighboring houses, …) is left at its
  // original coordinate, which for DAWA is the per-address adgangspunkt
  // and therefore already meaningful.
  //
  // Without this guard, three distinct addresses on the same street (e.g.
  // Nørholmsvej 55/57/59) whose adgangspunkter happen to fall inside one
  // shared building polygon all collapsed onto that polygon's centroid,
  // showing the pin on the wrong house. The DAWA fallback is per-address
  // and avoids the collision.
  const targets: Array<BuildingIndex | null> = new Array(data.places.length);
  const buildingHitCount = new Map<number, number>();
  for (let i = 0; i < data.places.length; i += 1) {
    const p = data.places[i]!;
    if (p.kind !== 'address') {
      targets[i] = null;
      continue;
    }
    const containing = findContainingBuilding(grid, p.lon, p.lat);
    targets[i] = containing;
    if (containing) {
      buildingHitCount.set(containing.key, (buildingHitCount.get(containing.key) ?? 0) + 1);
    }
  }

  const newPlaces: PlaceFeature[] = [];
  let snapped = 0;
  for (let i = 0; i < data.places.length; i += 1) {
    const p = data.places[i]!;
    const t = targets[i];
    if (t && (buildingHitCount.get(t.key) ?? 0) === 1) {
      newPlaces.push({ ...p, lat: t.centroid[1], lon: t.centroid[0] });
      snapped += 1;
    } else {
      newPlaces.push(p);
    }
  }

  return { data: { ...data, places: newPlaces }, snapped };
}

function indexBuilding(b: BuildingPolygon, key: number): BuildingIndex | null {
  if (!b.ring || b.ring.length < 3) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of b.ring) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
    sumLon += lon;
    sumLat += lat;
  }
  // Average-of-vertices is a fine approximation of the centroid for
  // small footprints. A proper polygon centroid (Stokes' shoelace) would
  // be marginally better but not worth the cycles at this resolution.
  const n = b.ring.length;
  return {
    key,
    centroid: [sumLon / n, sumLat / n] as const,
    bbox: [minLon, minLat, maxLon, maxLat] as const,
    ring: b.ring as ReadonlyArray<readonly [number, number]>,
  };
}

function findContainingBuilding(
  grid: Map<string, BuildingIndex[]>,
  lon: number,
  lat: number,
): BuildingIndex | null {
  const cx = Math.floor(lon / CELL_SIZE_DEG);
  const cy = Math.floor(lat / CELL_SIZE_DEG);
  const bucket = grid.get(`${cx},${cy}`);
  if (!bucket) return null;
  for (const b of bucket) {
    const [minLon, minLat, maxLon, maxLat] = b.bbox;
    if (
      lon < minLon - BUFFER_DEG ||
      lon > maxLon + BUFFER_DEG ||
      lat < minLat - BUFFER_DEG ||
      lat > maxLat + BUFFER_DEG
    ) {
      continue;
    }
    if (pointInRing(lon, lat, b.ring)) return b;
  }
  return null;
}

/**
 * Standard ray-casting point-in-polygon. The ring may be open or closed
 * (first === last) — we don't care, the algorithm works on both.
 */
function pointInRing(
  lon: number,
  lat: number,
  ring: ReadonlyArray<readonly [number, number]>,
): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
