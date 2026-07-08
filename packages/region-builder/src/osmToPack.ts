import type { RawOsm, RawOsmNode, RawOsmRelation, RawOsmWay } from './osmTypes.js';
import type {
  BuildingPolygon,
  PlaceFeature,
  RoadEdge,
  SyntheticData,
  WaterPolygon,
} from './synthetic.js';

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

  // Water polygons come from two sources:
  //
  //   1. Closed-ring ways tagged `natural=water` (small lakes), `waterway=
  //      riverbank` (rivers wide enough to be polygons), `waterway=dock`,
  //      or `landuse=reservoir|basin`. Self-contained — just resolve the
  //      ring.
  //
  //   2. Multipolygon relations tagged the same way, whose perimeter is
  //      split across multiple way members. The Limfjord, fjords, and
  //      large lakes-with-islands use this form. We chain outer member
  //      ways head-to-tail into rings and emit one WaterPolygon per ring.
  //      Inner (hole) rings are dropped — they'd render as a small island
  //      sub-painting, which we don't need for v1.
  //
  // Multipolygon outer ways have their own water tag less often than not
  // (the tag lives on the relation), so we must NOT double-emit them as
  // water via the way-only path below. We collect their way IDs first and
  // skip them in the way loop.
  const wayById = new Map<number, RawOsmWay>();
  for (const w of raw.ways) wayById.set(w.id, w);

  const waters: WaterPolygon[] = [];
  const consumedByRelation = new Set<number>();
  for (const r of raw.relations ?? []) {
    if (!isWaterRelation(r.tags)) continue;
    const rings = assembleMultipolygonRings(r, wayById, nodeById, 'outer');
    for (const member of r.members) {
      if (member.type === 'way') consumedByRelation.add(member.ref);
    }
    const name = r.tags.get('name');
    rings.forEach((ring, idx) => {
      waters.push({
        id: `osm:r${r.id}${rings.length > 1 ? `:${idx}` : ''}`,
        ...(name ? { name } : {}),
        ring,
      });
    });
  }

  for (const w of raw.ways) {
    if (!isWaterWay(w.tags)) continue;
    if (consumedByRelation.has(w.id)) continue;
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

  // Coastline closure: in OSM, fjords, seas, and ocean boundaries are
  // tagged as `natural=coastline` open ways with the convention "sea is
  // on the right when walking the way in its defined direction". They
  // are not polygons. To render the Limfjord and similar features as
  // water, we clip each coastline way to the pack bbox, then close the
  // open ends along the bbox perimeter on the sea side. See
  // `closeCoastlines` below for the full algorithm.
  //
  // We only do this when a clipBbox is supplied — without one the
  // coastline isn't bounded and we'd have no way to close it.
  if (opts.clipBbox) {
    // Coastlines routinely extend past the pack bbox, so resolving their
    // node refs against the clipped nodeById would lose the
    // "near-the-boundary" segments we specifically need for closure.
    // Build a one-off unfiltered lookup over raw.nodes for this step.
    const allNodes = new Map<number, RawOsmNode>();
    for (const n of raw.nodes) allNodes.set(n.id, n);

    // Collect coastline ways as node-id sequences so we can chain them
    // by matching shared endpoint IDs (much more reliable than matching
    // by float coordinates).
    const coastSegments: Array<{ nodeIds: number[] }> = [];
    for (const w of raw.ways) {
      if (w.tags.get('natural') !== 'coastline') continue;
      const ids: number[] = [];
      for (const ref of w.nodeRefs) {
        if (!allNodes.has(ref)) continue;
        ids.push(ref);
      }
      if (ids.length >= 2) coastSegments.push({ nodeIds: ids });
    }
    // Chain by shared endpoint IDs into longer polylines. The fjord
    // shoreline at Aalborg is split across several ways (one per
    // mapping pass historically); chaining glues them back together so
    // the clip+closure step sees one continuous coastline per shore.
    const chains = chainSegments(coastSegments);
    const coastlinePolylines: Array<Array<[number, number]>> = chains.map((ids) =>
      ids.map((id) => {
        const n = allNodes.get(id)!;
        return [n.lon, n.lat] as [number, number];
      }),
    );
    if (coastlinePolylines.length > 0) {
      const seaRings = closeCoastlines(coastlinePolylines, opts.clipBbox);
      seaRings.forEach((ring, idx) => {
        waters.push({
          id: `osm:coast:${idx}`,
          ring,
        });
      });
    }
  }

  // Buildings: closed-ring ways tagged `building=*` and multipolygon
  // relations tagged the same way. We render footprints only — no
  // heights, no levels — because higher-zoom flat polygons are already
  // enough for the user to tell "this block has a building" from "this
  // block is open space". Heights would require either an extruded
  // renderer or a 3D fill-extrusion layer; both are deferred.
  const buildings: BuildingPolygon[] = [];
  const buildingWayConsumed = new Set<number>();
  for (const r of raw.relations ?? []) {
    if (r.tags.get('type') !== 'multipolygon') continue;
    if (!r.tags.get('building')) continue;
    const rings = assembleMultipolygonRings(r, wayById, nodeById, 'outer');
    for (const member of r.members) {
      if (member.type === 'way') buildingWayConsumed.add(member.ref);
    }
    const name = r.tags.get('name');
    rings.forEach((ring, idx) => {
      buildings.push({
        id: `osm:r${r.id}${rings.length > 1 ? `:${idx}` : ''}`,
        ...(name ? { name } : {}),
        ring,
      });
    });
  }
  for (const w of raw.ways) {
    if (!w.tags.get('building')) continue;
    if (buildingWayConsumed.has(w.id)) continue;
    const ring: Array<[number, number]> = [];
    let intact = true;
    for (const ref of w.nodeRefs) {
      const n = nodeById.get(ref);
      if (!n) { intact = false; break; }
      ring.push([n.lon, n.lat]);
    }
    if (!intact || ring.length < 4) continue;
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    const name = w.tags.get('name');
    buildings.push({
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
    buildings,
  };
}

/**
 * Greedily chain segments (each a node-id sequence) by shared endpoint
 * IDs into longer polylines. Used to glue coastline ways back into the
 * continuous shoreline that OSM mappers had in mind before they split
 * it across multiple `way` features.
 *
 * Closed-ring segments (head === tail) are emitted unchained.
 */
function chainSegments(segments: ReadonlyArray<{ nodeIds: number[] }>): number[][] {
  const remaining: number[][] = segments.map((s) => s.nodeIds.slice());
  const chains: number[][] = [];

  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    if (seed[0] === seed[seed.length - 1]) {
      chains.push(seed);
      continue;
    }
    const chain = seed.slice();
    let extended = true;
    while (extended && chain[0] !== chain[chain.length - 1]) {
      extended = false;
      for (let i = 0; i < remaining.length; i += 1) {
        const seg = remaining[i]!;
        const head = chain[0]!;
        const tail = chain[chain.length - 1]!;
        const sH = seg[0]!;
        const sT = seg[seg.length - 1]!;
        if (sH === tail) {
          for (let j = 1; j < seg.length; j += 1) chain.push(seg[j]!);
          remaining.splice(i, 1);
          extended = true;
          break;
        }
        if (sT === tail) {
          for (let j = seg.length - 2; j >= 0; j -= 1) chain.push(seg[j]!);
          remaining.splice(i, 1);
          extended = true;
          break;
        }
        if (sT === head) {
          for (let j = seg.length - 2; j >= 0; j -= 1) chain.unshift(seg[j]!);
          remaining.splice(i, 1);
          extended = true;
          break;
        }
        if (sH === head) {
          for (let j = 1; j < seg.length; j += 1) chain.unshift(seg[j]!);
          remaining.splice(i, 1);
          extended = true;
          break;
        }
      }
    }
    chains.push(chain);
  }
  return chains;
}

/**
 * Close `natural=coastline` open ways into sea polygons.
 *
 * OSM convention: when walking a coastline way in its defined direction,
 * **land is on the left, sea is on the right.** Coastlines are open
 * polylines; the renderer is expected to know which side is sea (the
 * "sea polygon" problem). We solve this for the local pack-bbox case:
 *
 *   1. Clip each coastline way to the bbox. Result is a list of "arcs",
 *      each starting and ending on the bbox boundary (or, for closed
 *      island ways fully inside, a closed ring — emitted directly as a
 *      LAND polygon, then we'd need to render water around it; we just
 *      skip these in v1 since they'd render as water islands instead).
 *
 *   2. Each arc's endpoints are projected onto a 1D perimeter parameter
 *      (0..4) where the four bbox edges are walked clockwise from SW:
 *      bottom (S, west→east) is t=0..1, right (E, south→north) is
 *      t=1..2, top (N, east→west) is t=2..3, left (W, north→south) is
 *      t=3..4. Going **clockwise** around the bbox increases t.
 *
 *   3. A coastline arc traversed in its OSM direction has sea on the
 *      right. Closing the sea polygon clockwise (interior on the right)
 *      means: traverse the arc, then walk the bbox perimeter clockwise
 *      (increasing t, wrapping at 4→0) until we reach the START of the
 *      next arc, traverse it, continue. The polygon closes when we get
 *      back to the original start.
 *
 *   4. This yields one or more disjoint sea polygons (e.g., two
 *      connected fjord segments meeting the bbox separately).
 */
function closeCoastlines(
  ways: ReadonlyArray<ReadonlyArray<[number, number]>>,
  clipBbox: readonly [number, number, number, number],
): Array<Array<[number, number]>> {
  const [minLon, minLat, maxLon, maxLat] = clipBbox;
  const inBox = (p: [number, number]): boolean =>
    p[0] >= minLon && p[0] <= maxLon && p[1] >= minLat && p[1] <= maxLat;

  // Clip each coastline polyline to the bbox, yielding zero-or-more arcs
  // per input way. Each arc is a sequence of [lon, lat], with endpoints
  // either inside the bbox (fully-interior closed island) or exactly on
  // the bbox boundary (entry/exit from a clip).
  interface Arc {
    points: Array<[number, number]>;
    startInside: boolean; // arc starts on bbox boundary if false
    endInside: boolean;
  }
  const arcs: Arc[] = [];
  for (const way of ways) {
    let current: Array<[number, number]> | null = null;
    let prevPt: [number, number] | null = null;
    let prevInside = false;
    for (let i = 0; i < way.length; i += 1) {
      const pt = way[i]!;
      const inside = inBox(pt);
      if (i === 0) {
        if (inside) { current = [pt]; }
        prevPt = pt;
        prevInside = inside;
        continue;
      }
      if (inside && prevInside) {
        current!.push(pt);
      } else if (inside && !prevInside) {
        // Entering the bbox — clip the segment.
        const entry = clipToBbox(prevPt!, pt, clipBbox);
        current = entry ? [entry, pt] : [pt];
      } else if (!inside && prevInside) {
        // Leaving the bbox — clip the segment and emit the arc.
        const exit = clipToBbox(prevPt!, pt, clipBbox);
        if (current) {
          if (exit) current.push(exit);
          if (current.length >= 2) {
            arcs.push({ points: current, startInside: false, endInside: false });
          }
          current = null;
        }
      } else {
        // Both outside; the segment might still cross the bbox entirely.
        // Skip — this is rare for coastlines (segments are short) and
        // missing one such crossing only undercounts arcs slightly.
      }
      prevPt = pt;
      prevInside = inside;
    }
    if (current && current.length >= 2) {
      // Way ended inside the bbox — fully-interior arc (e.g. a closed
      // island coastline). Mark both ends as "inside" so the closing
      // walker treats it as a self-closed ring.
      arcs.push({ points: current, startInside: true, endInside: true });
    }
  }

  // Project a point on the bbox boundary to a perimeter parameter t in
  // [0, 4). Used only for boundary endpoints. Going clockwise from SW:
  //   t=0..1: south edge, west→east
  //   t=1..2: east edge,  south→north
  //   t=2..3: north edge, east→west
  //   t=3..4: west edge,  north→south
  // A point not exactly on the boundary is snapped to the nearest edge,
  // which is robust against floating-point drift in clipToBbox.
  const perim = (p: [number, number]): number => {
    const [x, y] = p;
    const dS = Math.abs(y - minLat);
    const dE = Math.abs(x - maxLon);
    const dN = Math.abs(y - maxLat);
    const dW = Math.abs(x - minLon);
    const m = Math.min(dS, dE, dN, dW);
    if (m === dS) return (x - minLon) / (maxLon - minLon);
    if (m === dE) return 1 + (y - minLat) / (maxLat - minLat);
    if (m === dN) return 2 + (maxLon - x) / (maxLon - minLon);
    return 3 + (maxLat - y) / (maxLat - minLat);
  };

  // Walk the bbox boundary clockwise from `from` to `to` (both as t
  // values in [0,4)), emitting corner points encountered along the way.
  // The corners are at t = 1, 2, 3, 0 (in clockwise order from SW). We
  // wrap modulo 4 when to < from.
  const corners: Array<[number, [number, number]]> = [
    [1, [maxLon, minLat]], // SE
    [2, [maxLon, maxLat]], // NE
    [3, [minLon, maxLat]], // NW
    [4, [minLon, minLat]], // SW (== 0)
  ];
  const walkPerimeter = (from: number, to: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    let t = from;
    let target = to;
    if (target <= t) target += 4;
    for (let pass = 0; pass < 8; pass += 1) {
      // Find the next corner with t < c <= target.
      let next: { c: number; pt: [number, number] } | null = null;
      for (const [c0, pt] of corners) {
        const c = c0 > t ? c0 : c0 + 4;
        if (c <= target && (!next || c < next.c)) next = { c, pt };
      }
      if (!next) break;
      out.push(next.pt);
      t = next.c;
      if (t >= target) break;
    }
    return out;
  };

  // Build perimeter-index of arc starts so we can find "next arc after
  // we exited at parameter t". Only arcs with boundary start/end
  // participate in the perimeter walk; fully-interior arcs are emitted
  // as self-closed rings.
  interface BoundaryArc {
    start: number; // perimeter t
    end: number;   // perimeter t
    points: Array<[number, number]>;
    used: boolean;
  }
  const boundaryArcs: BoundaryArc[] = [];
  const interiorRings: Array<Array<[number, number]>> = [];
  for (const a of arcs) {
    if (a.startInside && a.endInside) {
      // Closed island. Emit as-is, force-closed. This represents LAND
      // surrounded by sea; we don't currently render it (would need
      // hole-cutting in the sea polygon).
      interiorRings.push(a.points.slice());
      continue;
    }
    // OSM convention: coastline walked in OSM direction has SEA on the
    // RIGHT. The perimeter walker below walks the bbox boundary CCW
    // (increasing t = west→east along south, then south→north along
    // east, …). For the assembled polygon's interior to be the sea
    // (CCW outer ring → interior on the left → sea on the left), we
    // need to reverse each coastline arc so that sea ends up on the
    // left of the polygon-boundary walk.
    const reversed = a.points.slice().reverse();
    boundaryArcs.push({
      start: perim(reversed[0]!),
      end: perim(reversed[reversed.length - 1]!),
      points: reversed,
      used: false,
    });
  }

  // Walk arcs into closed sea polygons. Start from any unused boundary
  // arc; traverse it; walk the perimeter clockwise to the start of the
  // next arc; traverse that arc; repeat until we return to where we
  // started.
  const rings: Array<Array<[number, number]>> = [];
  for (const seed of boundaryArcs) {
    if (seed.used) continue;
    const ring: Array<[number, number]> = [];
    let arc: BoundaryArc | undefined = seed;
    let safety = boundaryArcs.length * 2 + 4;
    const startT = seed.start;
    while (arc && safety-- > 0) {
      arc.used = true;
      for (const p of arc.points) ring.push(p);
      // Find next arc whose start is the smallest t > arc.end (mod 4),
      // not yet used.
      let bestArc: BoundaryArc | undefined;
      let bestT = Infinity;
      for (const candidate of boundaryArcs) {
        if (candidate.used) continue;
        let t = candidate.start;
        if (t <= arc.end) t += 4;
        if (t < bestT) { bestT = t; bestArc = candidate; }
      }
      // Will the perimeter walk reach back to startT before any other arc?
      let closeT = startT;
      if (closeT <= arc.end) closeT += 4;
      if (closeT <= bestT) {
        // Close the polygon by walking back to the seed's start.
        const cornersOnly = walkPerimeter(arc.end, startT);
        for (const p of cornersOnly) ring.push(p);
        ring.push(seed.points[0]!);
        break;
      }
      const corners2 = walkPerimeter(arc.end, bestArc!.start);
      for (const p of corners2) ring.push(p);
      arc = bestArc;
    }
    if (ring.length >= 4) rings.push(ring);
  }

  // For now we DROP interior coastline rings — they represent islands of
  // land and would need to be cut as holes in the surrounding sea polygon
  // to render correctly. v1: live with the small visual discrepancy.
  void interiorRings;

  return rings;
}

/**
 * Liang-Barsky clip of segment a→b against the bbox. Returns the
 * intersection point on the bbox boundary, or null if the segment doesn't
 * cross the boundary in the (a inside-or-outside) → (b inside-or-outside)
 * direction. Used by closeCoastlines to find the exact entry/exit point
 * for each coastline segment.
 */
function clipToBbox(
  a: [number, number],
  b: [number, number],
  bbox: readonly [number, number, number, number],
): [number, number] | null {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let tMin = 0;
  let tMax = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > tMax) return false; if (t > tMin) tMin = t; }
    else { if (t < tMin) return false; if (t < tMax) tMax = t; }
    return true;
  };
  if (!clip(-dx, a[0] - minLon)) return null;
  if (!clip(dx, maxLon - a[0])) return null;
  if (!clip(-dy, a[1] - minLat)) return null;
  if (!clip(dy, maxLat - a[1])) return null;
  // Choose the intersection on the bbox boundary: if a is inside, use
  // tMax (exit); if a is outside, use tMin (entry).
  const aInside =
    a[0] >= minLon && a[0] <= maxLon && a[1] >= minLat && a[1] <= maxLat;
  const t = aInside ? tMax : tMin;
  return [a[0] + dx * t, a[1] + dy * t];
}

function isWaterWay(tags: ReadonlyMap<string, string>): boolean {
  if (tags.get('natural') === 'water') return true;
  if (tags.get('waterway') === 'riverbank') return true;
  if (tags.get('waterway') === 'dock') return true;
  if (tags.get('landuse') === 'reservoir') return true;
  if (tags.get('landuse') === 'basin') return true;
  return false;
}

function isWaterRelation(tags: ReadonlyMap<string, string>): boolean {
  if (tags.get('type') !== 'multipolygon') return false;
  // Tag families that signal "the area enclosed by this multipolygon is water".
  // Same set as isWaterWay minus dock (rarely modeled as a multipolygon).
  if (tags.get('natural') === 'water') return true;
  if (tags.get('waterway') === 'riverbank') return true;
  if (tags.get('landuse') === 'reservoir') return true;
  if (tags.get('landuse') === 'basin') return true;
  return false;
}

/**
 * Chain OSM relation member ways (with the given role) head-to-tail into
 * closed rings. Each multipolygon usually has at least one outer ring; large
 * features like the Limfjord can have many disjoint outer rings.
 *
 * Algorithm:
 *   - Collect the member ways' coordinate lists.
 *   - Repeatedly pop a way and try to extend it by matching head/tail node
 *     IDs with another way's head/tail. Reverse a way when needed.
 *   - When the chain closes back on its own start node, emit it as a ring.
 *   - If we run out of matchable ways with the chain unclosed, abandon that
 *     ring — OSM data is messy and a partial fjord is better than a crash.
 *
 * The output rings are arrays of [lon, lat], forced-closed (first === last)
 * so they match the WaterPolygon contract.
 */
function assembleMultipolygonRings(
  relation: RawOsmRelation,
  wayById: ReadonlyMap<number, RawOsmWay>,
  nodeById: ReadonlyMap<number, RawOsmNode>,
  role: 'outer' | 'inner',
): Array<Array<[number, number]>> {
  // Materialize each member way as a list of node IDs we can splice on.
  // Skip members whose ways or endpoints we don't have (clipped-out, etc.).
  const segments: Array<{ nodeIds: number[] }> = [];
  for (const m of relation.members) {
    if (m.type !== 'way') continue;
    // Empty role on a multipolygon traditionally means "outer" (the
    // default), so accept both.
    if (m.role !== role && !(role === 'outer' && m.role === '')) continue;
    const way = wayById.get(m.ref);
    if (!way) continue;
    const ids: number[] = [];
    let intact = true;
    for (const ref of way.nodeRefs) {
      if (!nodeById.has(ref)) { intact = false; break; }
      ids.push(ref);
    }
    if (!intact || ids.length < 2) continue;
    segments.push({ nodeIds: ids });
  }
  if (segments.length === 0) return [];

  const rings: Array<Array<[number, number]>> = [];
  const remaining = segments.slice();

  while (remaining.length > 0) {
    // Start a new ring with the first remaining segment.
    const first = remaining.shift()!;
    const chain = first.nodeIds.slice();
    let extended = true;
    while (extended && chain[0] !== chain[chain.length - 1]) {
      extended = false;
      for (let i = 0; i < remaining.length; i += 1) {
        const seg = remaining[i]!;
        const tail = chain[chain.length - 1]!;
        const head = chain[0]!;
        const segHead = seg.nodeIds[0]!;
        const segTail = seg.nodeIds[seg.nodeIds.length - 1]!;
        if (segHead === tail) {
          // Append seg minus its first node (already on chain).
          for (let j = 1; j < seg.nodeIds.length; j += 1) chain.push(seg.nodeIds[j]!);
          remaining.splice(i, 1);
          extended = true;
          break;
        } else if (segTail === tail) {
          // Append reversed seg minus its last node.
          for (let j = seg.nodeIds.length - 2; j >= 0; j -= 1) chain.push(seg.nodeIds[j]!);
          remaining.splice(i, 1);
          extended = true;
          break;
        } else if (segTail === head) {
          // Prepend seg minus its last node.
          for (let j = seg.nodeIds.length - 2; j >= 0; j -= 1) chain.unshift(seg.nodeIds[j]!);
          remaining.splice(i, 1);
          extended = true;
          break;
        } else if (segHead === head) {
          // Prepend reversed seg minus its first node.
          for (let j = 1; j < seg.nodeIds.length; j += 1) chain.unshift(seg.nodeIds[j]!);
          remaining.splice(i, 1);
          extended = true;
          break;
        }
      }
    }
    // Only emit closed rings with at least 4 vertices (3 + closing dup).
    if (chain.length >= 4 && chain[0] === chain[chain.length - 1]) {
      const ring: Array<[number, number]> = [];
      let intact = true;
      for (const id of chain) {
        const n = nodeById.get(id);
        if (!n) { intact = false; break; }
        ring.push([n.lon, n.lat]);
      }
      if (intact) rings.push(ring);
    }
    // Unclosed chain → drop silently. OSM relations are sometimes
    // half-broken across clip boundaries; rendering nothing is better than
    // rendering a spike that crosses the bbox.
  }
  return rings;
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
