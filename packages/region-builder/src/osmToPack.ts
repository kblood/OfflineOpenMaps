import type { RawOsm, RawOsmNode, RawOsmWay } from './osmTypes.js';
import type { PlaceFeature, RoadEdge, SyntheticData, WaterPolygon } from './synthetic.js';

/**
 * Convert raw OSM data to the SyntheticData shape consumed by the
 * pack writers. This is the SHARED conversion pipeline used by both
 * the OSM XML reader and (eventually) the PBF reader.
 *
 * Rules (deliberately simple — a small subset of what Valhalla/BRouter do):
 *   - Highways with `highway=*` become roads. Profile permissions derived
 *     from `highway`, `access`, `motor_vehicle`, `bicycle`, `foot` tags.
 *   - One-way ways (`oneway=yes`) emit only forward edges; otherwise we emit
 *     both directions so the router can traverse them either way.
 *   - Named nodes (`place=*`, `amenity=*`, `shop=*`, `tourism=*`, `name=*`)
 *     become places in the geocode index.
 *   - We DON'T model turn restrictions, traffic signals, or barriers in v1.
 *     Adding them is a future enhancement that doesn't change the schema.
 */
export interface OsmToPackOpts {
  /**
   * If true, drop ways/places that fall outside `clipBbox`. Otherwise keep
   * everything (useful for Overpass extracts that are already clipped).
   */
  clipBbox?: [number, number, number, number];
  /** Only ways with these highway values become roads (default = all standard road types). */
  highwayWhitelist?: ReadonlySet<string>;
}

const DEFAULT_HIGHWAY_WHITELIST = new Set<string>([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'pedestrian',
  'footway',
  'path',
  'cycleway',
  'track',
  'steps',
]);

/** Default speeds (km/h) by highway class, used when maxspeed is absent. */
const DEFAULT_SPEED_KMH: Readonly<Record<string, number>> = {
  motorway: 110,
  motorway_link: 80,
  trunk: 90,
  trunk_link: 60,
  primary: 70,
  primary_link: 50,
  secondary: 60,
  secondary_link: 40,
  tertiary: 50,
  tertiary_link: 40,
  unclassified: 40,
  residential: 30,
  living_street: 15,
  service: 20,
  pedestrian: 5,
  footway: 5,
  path: 5,
  cycleway: 18,
  track: 30,
  steps: 3,
};

export function osmToPack(raw: RawOsm, opts: OsmToPackOpts = {}): SyntheticData {
  const whitelist = opts.highwayWhitelist ?? DEFAULT_HIGHWAY_WHITELIST;

  // Index nodes by id; track which ones are actually referenced by a kept way.
  const nodeById = new Map<number, RawOsmNode>();
  for (const n of raw.nodes) {
    if (opts.clipBbox && !inBbox(n.lat, n.lon, opts.clipBbox)) continue;
    nodeById.set(n.id, n);
  }

  const referencedNodeIds = new Set<number>();
  const edges: RoadEdge[] = [];
  let nextWayLocalId = 1;

  for (const w of raw.ways) {
    const highway = w.tags.get('highway');
    if (!highway || !whitelist.has(highway)) continue;
    const access = w.tags.get('access');
    if (access === 'no' || access === 'private') continue;

    const profile = profileForWay(w.tags, highway);

    // Build the chain of nodes that exist in our nodeById.
    const chain: RawOsmNode[] = [];
    for (const ref of w.nodeRefs) {
      const n = nodeById.get(ref);
      if (n) chain.push(n);
    }
    if (chain.length < 2) continue;

    // Per-profile oneway. Real OSM data treats `oneway=yes` as binding on
    // vehicles, while pedestrians (and often bicycles) keep their natural
    // bidirectional access — Aalborg's pedestrianised city centre is full
    // of one-way service streets that foot/bike legally traverse both
    // ways. We model this by emitting two edges per OSM way (forward and
    // reverse), then masking each direction's profile permissions by what
    // oneway tags allow.
    //
    //   oneway / oneway:vehicle = yes  ⇒ reverse has no car
    //   oneway:bicycle = yes           ⇒ reverse has no bike
    //                                    (default: bikes ignore vehicle oneway)
    //   oneway:foot   = yes            ⇒ reverse has no foot
    //                                    (default: pedestrians ignore vehicle oneway)
    const owVehicle =
      w.tags.get('oneway') === 'yes' ||
      w.tags.get('oneway:vehicle') === 'yes' ||
      highway === 'motorway' ||
      highway === 'motorway_link';
    // Bikes follow the vehicle one-way only when explicitly tagged so.
    // OSM convention: oneway:bicycle=no means bidirectional even on a
    // one-way street (very common in Denmark with contraflow bike lanes).
    const owBike =
      w.tags.get('oneway:bicycle') === 'yes' ||
      (owVehicle && w.tags.get('oneway:bicycle') !== 'no');
    // Pedestrians are essentially never one-way unless explicitly tagged
    // (e.g. an escalator). Most OSM mappers don't set oneway:foot, so the
    // safe default is "foot is bidirectional".
    const owFoot = w.tags.get('oneway:foot') === 'yes';

    // roadName: prefer the OSM `name` tag; fall back to `(highway-class)` so
    // unnamed service roads/footways still produce *some* label rather than
    // empty strings. `ref` (E45, A7…) is captured separately so the renderer
    // can show a route shield alongside the name.
    const roadName = w.tags.get('name') ?? `(${highway})`;
    const ref = w.tags.get('ref');
    const maxSpeedKmh = parseMaxspeed(w.tags.get('maxspeed')) ?? DEFAULT_SPEED_KMH[highway] ?? 30;
    const wayLocalId = nextWayLocalId++;

    for (let i = 0; i < chain.length - 1; i += 1) {
      const a = chain[i]!;
      const b = chain[i + 1]!;
      referencedNodeIds.add(a.id);
      referencedNodeIds.add(b.id);
      // Forward edge: full profile permissions.
      edges.push({
        fromNode: a.id,
        toNode: b.id,
        roadName,
        ...(ref ? { ref } : {}),
        highway,
        maxSpeedKmh,
        allowsCar: profile.car,
        allowsBike: profile.bike,
        allowsFoot: profile.foot,
        wayId: wayLocalId,
      });
      // Reverse edge: mask each profile by its oneway rules. We always
      // emit the reverse edge as long as *some* profile can use it, so
      // the router still finds the way in reverse for foot/bike.
      const revCar = profile.car && !owVehicle;
      const revBike = profile.bike && !owBike;
      const revFoot = profile.foot && !owFoot;
      if (revCar || revBike || revFoot) {
        edges.push({
          fromNode: b.id,
          toNode: a.id,
          roadName,
          ...(ref ? { ref } : {}),
          highway,
          maxSpeedKmh,
          allowsCar: revCar,
          allowsBike: revBike,
          allowsFoot: revFoot,
          wayId: wayLocalId,
        });
      }
    }
  }

  // Only keep nodes that are part of the routing graph. (Stand-alone POIs
  // that aren't on any kept way go into `places` below, not `nodes`.)
  const nodes: Array<{ id: number; lat: number; lon: number }> = [];
  for (const id of referencedNodeIds) {
    const n = nodeById.get(id);
    if (n) nodes.push({ id: n.id, lat: n.lat, lon: n.lon });
  }

  // bbox covers everything in scope (routing nodes + POIs + any other raw
  // node that survived clipping), so it's meaningful even when the graph is
  // empty. The CLI separately refuses to write a pack with no edges, but
  // `osmToPack` itself should never throw on valid input.
  const bboxSourceNodes: ReadonlyArray<{ lat: number; lon: number }> =
    nodes.length > 0 ? nodes : Array.from(nodeById.values());

  // Water polygons: closed-ring ways tagged natural=water (lakes, reservoirs,
  // ponds), waterway=riverbank (rivers wide enough to be polygons), or
  // landuse=reservoir. Multi-polygons via <relation> are NOT handled here
  // (the XML/PBF readers ignore relations); a lake with islands renders as
  // just its outer ring. Acceptable for v1 — sees ~95% of European water.
  const waters: WaterPolygon[] = [];
  for (const w of raw.ways) {
    if (!isWaterWay(w.tags)) continue;
    // Resolve refs against the clipped nodeById; drop the way if any node
    // is missing (typical when the way crosses the clip bbox and Overpass
    // didn't return out-of-bbox endpoints).
    const ring: Array<[number, number]> = [];
    let intact = true;
    for (const ref of w.nodeRefs) {
      const n = nodeById.get(ref);
      if (!n) { intact = false; break; }
      ring.push([n.lon, n.lat]);
    }
    if (!intact || ring.length < 4) continue;
    // OSM "areas" are conventionally closed (first === last) but not all
    // tools emit them that way. Force-close so GeoJSON consumers are happy.
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    const name = w.tags.get('name');
    waters.push({
      id: `osm:w${w.id}`,
      ...(name ? { name } : {}),
      ring,
    });
  }

  // Places: named nodes with place/amenity/shop/tourism tags. We also include
  // any named node, since OSM has a long tail of useful named features.
  // Address nodes (Karlsruhe schema: addr:housenumber + addr:street) are a
  // separate path — they usually have no `name` tag, so we synthesize a
  // display name from the address fields.
  const places: PlaceFeature[] = [];
  for (const n of nodeById.values()) {
    const addr = makeAddressPlace(n.tags);
    if (addr) {
      places.push({
        id: `osm:n${n.id}`,
        displayName: addr.displayName,
        kind: 'address',
        lat: n.lat,
        lon: n.lon,
        country: addr.country,
        adminPath: addr.adminPath,
        ...(addr.altNames ? { altNames: addr.altNames } : {}),
      });
      continue;
    }
    const kind = classifyPlace(n.tags);
    if (!kind) continue;
    const name = n.tags.get('name') ?? n.tags.get('ref');
    if (!name) continue;
    places.push({
      id: `osm:n${n.id}`,
      displayName: name,
      kind,
      lat: n.lat,
      lon: n.lon,
      country: (n.tags.get('addr:country') ?? 'XX').toUpperCase().slice(0, 2),
      adminPath: n.tags.get('addr:city') ?? null,
      ...(n.tags.get('alt_name') ? { altNames: n.tags.get('alt_name')! } : {}),
    });
  }

  // OSM convention puts most addresses on building outlines (closed ways
  // tagged building=* + addr:housenumber), not on standalone nodes. Per
  // the wiki, building-ways outnumber address-nodes roughly 3:1. We emit
  // an address place at the way's centroid so users can search for them.
  for (const w of raw.ways) {
    const addr = makeAddressPlace(w.tags);
    if (!addr) continue;
    let sumLat = 0;
    let sumLon = 0;
    let count = 0;
    // Closed-ring buildings repeat their first node as the last node ref.
    // Deduplicate so that vertex isn't double-weighted in the centroid.
    const seen = new Set<number>();
    for (const ref of w.nodeRefs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      const n = nodeById.get(ref);
      if (!n) continue;
      sumLat += n.lat;
      sumLon += n.lon;
      count += 1;
    }
    if (count === 0) continue;
    places.push({
      id: `osm:w${w.id}`,
      displayName: addr.displayName,
      kind: 'address',
      lat: sumLat / count,
      lon: sumLon / count,
      country: addr.country,
      adminPath: addr.adminPath,
      ...(addr.altNames ? { altNames: addr.altNames } : {}),
    });
  }

  return {
    bbox: computeBbox(bboxSourceNodes, opts.clipBbox),
    nodes,
    edges,
    places,
    waters,
  };
}

function isWaterWay(tags: ReadonlyMap<string, string>): boolean {
  if (tags.get('natural') === 'water') return true;
  if (tags.get('waterway') === 'riverbank') return true;
  if (tags.get('waterway') === 'dock') return true;
  if (tags.get('landuse') === 'reservoir') return true;
  if (tags.get('landuse') === 'basin') return true;
  return false;
}

function profileForWay(
  tags: ReadonlyMap<string, string>,
  highway: string,
): { car: boolean; bike: boolean; foot: boolean } {
  // Start with sensible defaults per highway class, then apply tag overrides.
  let car = true;
  let bike = true;
  let foot = true;

  switch (highway) {
    case 'motorway':
    case 'motorway_link':
      bike = false;
      foot = false;
      break;
    case 'trunk':
    case 'trunk_link':
      // foot allowed by default unless tagged otherwise
      break;
    case 'cycleway':
      car = false;
      break;
    case 'footway':
    case 'pedestrian':
    case 'path':
    case 'steps':
      car = false;
      break;
    case 'track':
      // tracks can be vehicle-accessible but usually only foot/bike
      car = false;
      break;
    default:
      break;
  }

  const motor = tags.get('motor_vehicle') ?? tags.get('vehicle');
  if (motor === 'no' || motor === 'private') car = false;
  if (motor === 'yes' || motor === 'designated') car = true;

  const bicycle = tags.get('bicycle');
  if (bicycle === 'no' || bicycle === 'private') bike = false;
  if (bicycle === 'yes' || bicycle === 'designated') bike = true;

  const footTag = tags.get('foot');
  if (footTag === 'no' || footTag === 'private') foot = false;
  if (footTag === 'yes' || footTag === 'designated') foot = true;

  return { car, bike, foot };
}

function parseMaxspeed(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(km\/h|kmh|mph)?$/i.exec(v.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n)) return undefined;
  if (m[2] && m[2].toLowerCase() === 'mph') return n * 1.609344;
  return n;
}

interface AddressFields {
  displayName: string;
  country: string;
  adminPath: string | null;
  /** Extra searchable variants joined by spaces (street, city, postcode). */
  altNames?: string;
}

/**
 * If `tags` represents an OSM-Karlsruhe address (housenumber + street),
 * return the fields we want indexed. Returns null otherwise so callers
 * can fall through to other classifications.
 *
 * Display order is "Street Number" — the dominant European format and what
 * the bundled Aalborg pack uses. North-American "Number Street" still
 * matches in FTS because we store the same tokens in alt_names with the
 * city and postcode appended, and the search query tokens are AND-joined,
 * not phrase-matched.
 */
function makeAddressPlace(tags: ReadonlyMap<string, string>): AddressFields | null {
  const number = tags.get('addr:housenumber');
  const street = tags.get('addr:street');
  if (!number || !street) return null;
  const city = tags.get('addr:city') ?? null;
  const postcode = tags.get('addr:postcode') ?? null;
  const country = (tags.get('addr:country') ?? 'XX').toUpperCase().slice(0, 2);
  const displayName = `${street} ${number}`;
  // alt_names gives FTS a single line with every searchable token. Searches
  // like "Strandvejen 42 Aalborg" or "9000 Strandvejen 42" both work because
  // FTS5 AND-joins the tokens regardless of order.
  const altBits: string[] = [street, number];
  if (postcode) altBits.push(postcode);
  if (city) altBits.push(city);
  const altNames = altBits.join(' ');
  return {
    displayName,
    country,
    adminPath: city,
    altNames,
  };
}

function classifyPlace(tags: ReadonlyMap<string, string>): PlaceFeature['kind'] | null {
  if (tags.has('place')) return 'place';
  if (tags.has('amenity') || tags.has('shop') || tags.has('tourism')) return 'poi';
  if (tags.has('addr:housenumber')) return 'address';
  if (tags.get('boundary') === 'administrative') return 'admin';
  return null;
}

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

function computeBbox(
  nodes: ReadonlyArray<{ lat: number; lon: number }>,
  fallback?: [number, number, number, number],
): [number, number, number, number] {
  if (nodes.length === 0) {
    if (fallback) return fallback;
    throw new Error('cannot compute bbox: no nodes');
  }
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const n of nodes) {
    if (n.lat < minLat) minLat = n.lat;
    if (n.lat > maxLat) maxLat = n.lat;
    if (n.lon < minLon) minLon = n.lon;
    if (n.lon > maxLon) maxLon = n.lon;
  }
  return [minLon, minLat, maxLon, maxLat];
}
