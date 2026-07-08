// Generates a deterministic synthetic region used as a fixture for tests
// and for first-run demos. NOT representative of real OSM data, but it's a
// real road graph, real named places, and real MVT tiles — enough to prove
// the offline pipeline end-to-end.
//
// Geography: "Fakeland", a 0.1° × 0.1° rectangle centered at lat=42.5, lon=1.6
// (roughly the size and location of Andorra). Inside, a 6×6 grid of roads on
// a 0.02° spacing forms a tiny town. Five named places sit at grid intersections,
// plus a couple of POIs.

export interface RoadEdge {
  fromNode: number;
  toNode: number;
  roadName: string;
  /**
   * OSM `ref` tag — route designator (e.g. "E45", "A7", "M3"). Distinct
   * from `roadName` because many ways carry both: motorways usually have
   * a ref but no name; numbered city streets in some countries have both.
   * Optional because most residential streets don't have a ref.
   */
  ref?: string;
  /**
   * Raw OSM `highway` value — "motorway", "primary", "residential",
   * "cycleway", "footway", "path", "steps", "service", etc. Kept as a
   * free-form string rather than an enum so we don't have to enumerate
   * every dialect; the renderer filters with explicit-value checks.
   */
  highway: string;
  maxSpeedKmh: number;
  allowsCar: boolean;
  allowsBike: boolean;
  allowsFoot: boolean;
  wayId: number;
}

export interface PlaceFeature {
  id: string;
  displayName: string;
  kind: 'place' | 'admin' | 'poi' | 'street' | 'address';
  lat: number;
  lon: number;
  country: string;
  adminPath: string | null;
  altNames?: string;
  /**
   * For DK addresses sourced from DAWA: the matrikel/parcel identifier
   * ("<ejerlavkode>/<matrikelnr>") so the UI can look up and render
   * the parcel polygon on selection. Other place kinds leave this unset.
   */
  parcelId?: string | null;
}

/**
 * A closed-ring water body (lake, reservoir, pond, river-as-polygon).
 * `ring` is the outer boundary as [lon, lat] pairs; first and last point
 * are equal (closed ring, as GeoJSON polygons expect).
 *
 * We deliberately don't model multi-polygons (lakes with islands) yet —
 * those are encoded as OSM relations, which the readers skip. A future
 * pass can add inner-ring holes; for now we just render the outer ring.
 */
export interface WaterPolygon {
  /** Stable identifier — usually `osm:w<wayId>` from the source data. */
  id: string;
  /** Optional name for label rendering ("Limfjorden", "Vesterhavet"). */
  name?: string;
  /** Outer ring: array of [lon, lat] pairs, closed (first === last). */
  ring: ReadonlyArray<[number, number]>;
}

/**
 * A building footprint. Same shape as WaterPolygon — an outer ring,
 * optionally a name (for prominent landmarks, like train stations or
 * cathedrals). Heights/levels are intentionally not modeled in v1; that
 * would invite the rendering complexity of extruded geometry without
 * solving any user-visible problem yet.
 */
export interface BuildingPolygon {
  id: string;
  name?: string;
  ring: ReadonlyArray<[number, number]>;
}

export interface SyntheticData {
  bbox: [number, number, number, number];
  nodes: ReadonlyArray<{ id: number; lat: number; lon: number }>;
  edges: ReadonlyArray<RoadEdge>;
  places: ReadonlyArray<PlaceFeature>;
  /**
   * Closed water polygons (lakes, reservoirs, river-as-area). Optional in
   * the type so the synthetic Fakeland fixture doesn't have to invent any,
   * but real OSM imports populate it. Empty array is fine.
   */
  waters?: ReadonlyArray<WaterPolygon>;
  /**
   * Building footprints. Same optional contract as waters — present in
   * real OSM imports, absent in synthetic fixtures.
   */
  buildings?: ReadonlyArray<BuildingPolygon>;
  /**
   * Cadastral parcels (matrikler) bundled from DAWA for DK packs. Each
   * parcel polygon is keyed by "<ejerlavkode>/<matrikelnr>" and is referenced
   * by address-kind PlaceFeatures via their `parcelId`. Empty/absent for
   * non-DK packs.
   */
  parcels?: ReadonlyArray<ParcelGeometry>;
}

/**
 * A cadastral parcel (matrikel) — same shape as the DAWA fetcher's
 * ParcelPolygon, but lives in synthetic.ts so the writer doesn't have
 * to import from the fetcher. Multiple rings supports MultiPolygon
 * parcels (rare but legal in the registry).
 */
export interface ParcelGeometry {
  id: string;
  label: string;
  ejerlavkode: number;
  ejerlavnavn: string;
  matrikelnr: string;
  rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
}

export function buildFakelandData(): SyntheticData {
  const cx = 1.6;
  const cy = 42.5;
  const halfW = 0.05;
  const halfH = 0.05;
  const bbox: [number, number, number, number] = [cx - halfW, cy - halfH, cx + halfW, cy + halfH];

  const GRID = 6; // 6x6 = 36 nodes
  const stepLon = (halfW * 2) / (GRID - 1);
  const stepLat = (halfH * 2) / (GRID - 1);

  const nodes: Array<{ id: number; lat: number; lon: number }> = [];
  const idOf = (gx: number, gy: number): number => gy * GRID + gx + 1;
  for (let gy = 0; gy < GRID; gy += 1) {
    for (let gx = 0; gx < GRID; gx += 1) {
      nodes.push({
        id: idOf(gx, gy),
        lon: bbox[0] + gx * stepLon,
        lat: bbox[1] + gy * stepLat,
      });
    }
  }

  // Roads: horizontal "streets" (named "1st Street" .. "6th Street")
  // and vertical "avenues" ("Avenue A" .. "Avenue F"). Each grid edge becomes
  // a bidirectional pair of edges so Dijkstra works in both directions.
  const edges: RoadEdge[] = [];
  let wayId = 1;
  for (let gy = 0; gy < GRID; gy += 1) {
    const streetName = `${ordinal(gy + 1)} Street`;
    for (let gx = 0; gx < GRID - 1; gx += 1) {
      const a = idOf(gx, gy);
      const b = idOf(gx + 1, gy);
      edges.push(roadEdge(a, b, streetName, wayId));
      edges.push(roadEdge(b, a, streetName, wayId));
      wayId += 1;
    }
  }
  for (let gx = 0; gx < GRID; gx += 1) {
    const avenueName = `Avenue ${String.fromCharCode(65 + gx)}`;
    for (let gy = 0; gy < GRID - 1; gy += 1) {
      const a = idOf(gx, gy);
      const b = idOf(gx, gy + 1);
      edges.push(roadEdge(a, b, avenueName, wayId));
      edges.push(roadEdge(b, a, avenueName, wayId));
      wayId += 1;
    }
  }

  // A handful of named places. The first one ("Faketown") is the self-test
  // search anchor — manifest references it.
  const placeAt = (gx: number, gy: number) => ({
    lon: bbox[0] + gx * stepLon,
    lat: bbox[1] + gy * stepLat,
  });
  const places: PlaceFeature[] = [
    { id: 'p:faketown',  ...placeAt(2, 2), displayName: 'Faketown',  kind: 'place', country: 'XX', adminPath: 'Fakeland', altNames: 'Falsa Villa' },
    { id: 'p:nordport',  ...placeAt(0, 5), displayName: 'Nordport',  kind: 'place', country: 'XX', adminPath: 'Fakeland' },
    { id: 'p:sudburg',   ...placeAt(5, 0), displayName: 'Sudburg',   kind: 'place', country: 'XX', adminPath: 'Fakeland' },
    { id: 'p:hillpoint', ...placeAt(4, 4), displayName: 'Hillpoint', kind: 'place', country: 'XX', adminPath: 'Fakeland' },
    { id: 'p:rivertown', ...placeAt(1, 3), displayName: 'Rivertown', kind: 'place', country: 'XX', adminPath: 'Fakeland' },
    { id: 'poi:cafe-central', ...placeAt(2, 3), displayName: 'Cafe Central', kind: 'poi', country: 'XX', adminPath: 'Faketown' },
    { id: 'poi:library',      ...placeAt(3, 3), displayName: 'Public Library', kind: 'poi', country: 'XX', adminPath: 'Faketown' },
  ];

  return { bbox, nodes, edges, places };
}

function roadEdge(from: number, to: number, name: string, wayId: number): RoadEdge {
  return {
    fromNode: from,
    toNode: to,
    roadName: name,
    highway: 'residential',
    maxSpeedKmh: 50,
    allowsCar: true,
    allowsBike: true,
    allowsFoot: true,
    wayId,
  };
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
