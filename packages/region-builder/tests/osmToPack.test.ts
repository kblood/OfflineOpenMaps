/**
 * Direct unit tests for osmToPack — no I/O, no SQLite, just shape transforms.
 * These pin down the OSM → SyntheticData rules that osm-pack.test.ts only
 * exercises indirectly.
 */
import { describe, expect, it } from 'vitest';
import { osmToPack } from '../src/osmToPack.js';
import type { RawOsm } from '../src/osmTypes.js';

function rawOsm(opts: {
  nodes: Array<{ id: number; lat: number; lon: number; tags?: Record<string, string> }>;
  ways: Array<{ id: number; refs: number[]; tags: Record<string, string> }>;
}): RawOsm {
  return {
    nodes: opts.nodes.map((n) => ({
      id: n.id,
      lat: n.lat,
      lon: n.lon,
      tags: new Map(Object.entries(n.tags ?? {})),
    })),
    ways: opts.ways.map((w) => ({
      id: w.id,
      nodeRefs: w.refs,
      tags: new Map(Object.entries(w.tags)),
    })),
  };
}

describe('osmToPack', () => {
  it('drops ways without a highway= tag', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0.001, lon: 0.001 },
      ],
      ways: [
        { id: 100, refs: [1, 2], tags: { building: 'yes' } },
        { id: 101, refs: [1, 2], tags: { landuse: 'park' } },
      ],
    });
    const data = osmToPack(raw);
    expect(data.edges).toHaveLength(0);
    expect(data.nodes).toHaveLength(0);
  });

  it('drops ways whose highway value is outside the whitelist', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0.001, lon: 0.001 },
      ],
      ways: [
        { id: 100, refs: [1, 2], tags: { highway: 'proposed' } },
        { id: 101, refs: [1, 2], tags: { highway: 'raceway' } },
      ],
    });
    expect(osmToPack(raw).edges).toHaveLength(0);
  });

  it('drops ways tagged access=no or access=private', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0.001, lon: 0.001 },
      ],
      ways: [
        { id: 100, refs: [1, 2], tags: { highway: 'residential', access: 'no' } },
        { id: 101, refs: [1, 2], tags: { highway: 'residential', access: 'private' } },
      ],
    });
    expect(osmToPack(raw).edges).toHaveLength(0);
  });

  it('emits 2 edges per bidirectional segment; oneway only blocks cars in reverse', () => {
    // Real OSM convention: oneway=yes is a vehicle restriction. Pedestrians
    // (and by default bikes) traverse one-way streets in both directions —
    // a single OSM way like "Bispensgade" in Aalborg is car-oneway but
    // foot-bidirectional. We model this by always emitting a reverse edge
    // as long as ANY profile can use it, and masking off the disallowed
    // profile flags on that reverse edge.
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
        { id: 3, lat: 0, lon: 0.002 },
        { id: 4, lat: 0, lon: 0.003 },
      ],
      ways: [
        // bidirectional: 3 segments × 2 dirs = 6 edges, all profiles each way
        { id: 100, refs: [1, 2, 3, 4], tags: { highway: 'residential', name: 'Two-Way' } },
        // oneway: 3 segments × 2 dirs = 6 edges, but reverse direction has allowsCar=false
        { id: 101, refs: [1, 2, 3, 4], tags: { highway: 'residential', oneway: 'yes', name: 'One-Way' } },
      ],
    });
    const data = osmToPack(raw);
    const twoWay = data.edges.filter((e) => e.roadName === 'Two-Way');
    const oneWay = data.edges.filter((e) => e.roadName === 'One-Way');
    expect(twoWay).toHaveLength(6);
    expect(oneWay).toHaveLength(6);
    // Reverse direction (toNode < fromNode in our ascending-id test data)
    // must have car blocked but foot allowed.
    const oneWayReverse = oneWay.filter((e) => e.fromNode > e.toNode);
    expect(oneWayReverse).toHaveLength(3);
    for (const e of oneWayReverse) {
      expect(e.allowsCar).toBe(false);
      expect(e.allowsFoot).toBe(true);
    }
    // Forward direction unchanged.
    const oneWayForward = oneWay.filter((e) => e.fromNode < e.toNode);
    for (const e of oneWayForward) {
      expect(e.allowsCar).toBe(true);
      expect(e.allowsFoot).toBe(true);
    }
  });

  it('honours oneway:foot=yes by blocking foot in the reverse direction only', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
      ],
      ways: [
        { id: 100, refs: [1, 2], tags: { highway: 'footway', 'oneway:foot': 'yes' } },
      ],
    });
    const data = osmToPack(raw);
    // Both forward and reverse edges still emit (bikes can use the way
    // in both directions on a default footway). The reverse edge has foot
    // blocked specifically.
    expect(data.edges).toHaveLength(2);
    const fwd = data.edges.find((e) => e.fromNode === 1)!;
    const rev = data.edges.find((e) => e.fromNode === 2)!;
    expect(fwd.allowsFoot).toBe(true);
    expect(rev.allowsFoot).toBe(false);
    expect(rev.allowsBike).toBe(true);
  });

  it('oneway:bicycle=no keeps bikes bidirectional on a one-way street', () => {
    // Contraflow bike lane convention: oneway=yes for cars, oneway:bicycle=no
    // means bikes can legally ride either direction. Common in Copenhagen
    // and most of Denmark.
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
      ],
      ways: [
        { id: 100, refs: [1, 2], tags: { highway: 'residential', oneway: 'yes', 'oneway:bicycle': 'no' } },
      ],
    });
    const data = osmToPack(raw);
    expect(data.edges).toHaveLength(2);
    const reverse = data.edges.find((e) => e.fromNode === 2)!;
    expect(reverse.allowsCar).toBe(false);
    expect(reverse.allowsBike).toBe(true);
    expect(reverse.allowsFoot).toBe(true);
  });

  it('motorway is implicitly oneway even without oneway=yes', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
      ],
      ways: [
        { id: 100, refs: [1, 2], tags: { highway: 'motorway' } },
        { id: 101, refs: [1, 2], tags: { highway: 'motorway_link' } },
      ],
    });
    const data = osmToPack(raw);
    expect(data.edges).toHaveLength(2); // 1 + 1 (both implicitly oneway)
  });

  it('profile: motorway forbids foot and bike', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
      ],
      ways: [{ id: 100, refs: [1, 2], tags: { highway: 'motorway' } }],
    });
    const e = osmToPack(raw).edges[0]!;
    expect(e.allowsCar).toBe(true);
    expect(e.allowsBike).toBe(false);
    expect(e.allowsFoot).toBe(false);
  });

  it('profile: footway forbids cars but allows bike+foot', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
      ],
      ways: [{ id: 100, refs: [1, 2], tags: { highway: 'footway' } }],
    });
    const e = osmToPack(raw).edges[0]!;
    expect(e.allowsCar).toBe(false);
    expect(e.allowsBike).toBe(true);
    expect(e.allowsFoot).toBe(true);
  });

  it('profile: cycleway forbids cars', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
      ],
      ways: [{ id: 100, refs: [1, 2], tags: { highway: 'cycleway' } }],
    });
    const e = osmToPack(raw).edges[0]!;
    expect(e.allowsCar).toBe(false);
    expect(e.allowsBike).toBe(true);
  });

  it('profile: motor_vehicle=no overrides default car access', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
      ],
      ways: [
        { id: 100, refs: [1, 2], tags: { highway: 'residential', motor_vehicle: 'no' } },
      ],
    });
    const e = osmToPack(raw).edges[0]!;
    expect(e.allowsCar).toBe(false);
    // bike/foot defaults preserved
    expect(e.allowsBike).toBe(true);
    expect(e.allowsFoot).toBe(true);
  });

  it('profile: bicycle=designated re-enables bike on a track', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
      ],
      ways: [
        { id: 100, refs: [1, 2], tags: { highway: 'track', bicycle: 'designated' } },
      ],
    });
    const e = osmToPack(raw).edges[0]!;
    expect(e.allowsBike).toBe(true);
  });

  it('maxspeed: numeric value is used, mph is converted', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
        { id: 3, lat: 0, lon: 0.002 },
      ],
      ways: [
        { id: 100, refs: [1, 2], tags: { highway: 'residential', maxspeed: '40' } },
        { id: 101, refs: [2, 3], tags: { highway: 'residential', maxspeed: '30 mph' } },
      ],
    });
    const data = osmToPack(raw);
    const fwd100 = data.edges.find((e) => e.fromNode === 1 && e.toNode === 2)!;
    const fwd101 = data.edges.find((e) => e.fromNode === 2 && e.toNode === 3)!;
    expect(fwd100.maxSpeedKmh).toBe(40);
    // 30 mph ≈ 48.28 km/h
    expect(fwd101.maxSpeedKmh).toBeGreaterThan(48);
    expect(fwd101.maxSpeedKmh).toBeLessThan(49);
  });

  it('maxspeed: falls back to per-class default when absent', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
      ],
      ways: [{ id: 100, refs: [1, 2], tags: { highway: 'motorway' } }],
    });
    const e = osmToPack(raw).edges[0]!;
    expect(e.maxSpeedKmh).toBe(110); // DEFAULT_SPEED_KMH.motorway
  });

  it('skips way segments referencing nodes that were not in the file', () => {
    // If a way references node 999 but the file only contains 1 and 2, that
    // segment is silently dropped. This is what happens when an Overpass
    // extract clips a way at the bbox edge.
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
      ],
      ways: [
        { id: 100, refs: [1, 2, 999], tags: { highway: 'residential' } },
      ],
    });
    const data = osmToPack(raw);
    // 1 segment kept (1->2). The missing node 999 doesn't materialize.
    expect(data.edges).toHaveLength(2); // bidirectional
    expect(data.edges.every((e) => e.fromNode !== 999 && e.toNode !== 999)).toBe(true);
  });

  it('place classification: named node with place=* is a place', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0, tags: { place: 'village', name: 'Somewhere' } },
      ],
      ways: [],
    });
    const data = osmToPack(raw);
    expect(data.places).toHaveLength(1);
    expect(data.places[0]!.kind).toBe('place');
    expect(data.places[0]!.displayName).toBe('Somewhere');
  });

  it('place classification: amenity/shop/tourism becomes a POI', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0, tags: { amenity: 'cafe', name: 'A' } },
        { id: 2, lat: 0, lon: 0, tags: { shop: 'bakery', name: 'B' } },
        { id: 3, lat: 0, lon: 0, tags: { tourism: 'museum', name: 'C' } },
      ],
      ways: [],
    });
    const places = osmToPack(raw).places;
    expect(places.every((p) => p.kind === 'poi')).toBe(true);
    expect(places.map((p) => p.displayName).sort()).toEqual(['A', 'B', 'C']);
  });

  it('place classification: unnamed POI tag is dropped', () => {
    // amenity=parking with no name should not become a searchable place.
    const raw = rawOsm({
      nodes: [{ id: 1, lat: 0, lon: 0, tags: { amenity: 'parking' } }],
      ways: [],
    });
    expect(osmToPack(raw).places).toHaveLength(0);
  });

  it('clipBbox option drops nodes outside the bbox', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
        { id: 3, lat: 10, lon: 10 }, // far outside
      ],
      ways: [
        { id: 100, refs: [1, 2], tags: { highway: 'residential' } },
        { id: 101, refs: [1, 3], tags: { highway: 'residential' } }, // straddles
      ],
    });
    const data = osmToPack(raw, { clipBbox: [-0.01, -0.01, 0.01, 0.01] });
    // Node 3 is dropped; way 101's segment 1->3 is then skipped (only 1 node
    // resolved). Way 100 stays.
    expect(data.nodes.every((n) => n.id !== 3)).toBe(true);
    expect(data.edges.every((e) => e.fromNode !== 3 && e.toNode !== 3)).toBe(true);
  });

  it('bbox is computed from kept nodes', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 10, lon: 20 },
        { id: 2, lat: 11, lon: 21 },
      ],
      ways: [{ id: 100, refs: [1, 2], tags: { highway: 'residential' } }],
    });
    const data = osmToPack(raw);
    expect(data.bbox).toEqual([20, 10, 21, 11]);
  });

  it('keeps name and ref as separate fields; falls back to (highway) placeholder when both are missing', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
        { id: 3, lat: 0, lon: 0.002 },
        { id: 4, lat: 0, lon: 0.003 },
        { id: 5, lat: 0, lon: 0.004 },
      ],
      ways: [
        { id: 100, refs: [1, 2], tags: { highway: 'primary', name: 'Has Name' } },
        { id: 101, refs: [2, 3], tags: { highway: 'primary', ref: 'A12' } },
        { id: 102, refs: [3, 4], tags: { highway: 'primary' } },
        { id: 103, refs: [4, 5], tags: { highway: 'motorway', name: 'Pan-Euro', ref: 'E45' } },
      ],
    });
    const data = osmToPack(raw);
    // Filter by both endpoints — find-by-fromNode alone is ambiguous because
    // bidirectional edges from way 100 (2->1) collide with way 101 (2->3).
    const named = data.edges.find((e) => e.fromNode === 1 && e.toNode === 2)!;
    const reffed = data.edges.find((e) => e.fromNode === 2 && e.toNode === 3)!;
    const anon = data.edges.find((e) => e.fromNode === 3 && e.toNode === 4)!;
    const both = data.edges.find((e) => e.fromNode === 4 && e.toNode === 5)!;
    expect(named.roadName).toBe('Has Name');
    expect(named.ref).toBeUndefined();
    expect(reffed.roadName).toBe('(primary)');
    expect(reffed.ref).toBe('A12');
    expect(anon.roadName).toBe('(primary)');
    expect(anon.ref).toBeUndefined();
    expect(both.roadName).toBe('Pan-Euro');
    expect(both.ref).toBe('E45');
  });

  it('emits address places from nodes with addr:housenumber + addr:street', () => {
    const raw = rawOsm({
      nodes: [
        {
          id: 1,
          lat: 57.05,
          lon: 9.92,
          tags: {
            'addr:housenumber': '42',
            'addr:street': 'Strandvejen',
            'addr:city': 'Aalborg',
            'addr:postcode': '9000',
          },
        },
        // No name + no addr — should be dropped.
        { id: 2, lat: 57.0, lon: 9.9 },
      ],
      ways: [],
    });
    const places = osmToPack(raw).places;
    expect(places).toHaveLength(1);
    expect(places[0]!.kind).toBe('address');
    expect(places[0]!.displayName).toBe('Strandvejen 42');
    expect(places[0]!.adminPath).toBe('Aalborg');
    expect(places[0]!.altNames).toContain('9000');
    expect(places[0]!.altNames).toContain('Aalborg');
    expect(places[0]!.altNames).toContain('Strandvejen');
  });

  it('emits address places at building-way centroids', () => {
    // Four-corner building with addr tags on the way (the dominant OSM
    // convention). The address place's lat/lon should be the centroid.
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
        { id: 3, lat: 0.001, lon: 0.001 },
        { id: 4, lat: 0.001, lon: 0 },
      ],
      ways: [
        {
          id: 100,
          refs: [1, 2, 3, 4, 1],
          tags: {
            building: 'yes',
            'addr:housenumber': '7',
            'addr:street': 'Main St',
            'addr:city': 'Springfield',
          },
        },
      ],
    });
    const addresses = osmToPack(raw).places.filter((p) => p.kind === 'address');
    expect(addresses).toHaveLength(1);
    expect(addresses[0]!.displayName).toBe('Main St 7');
    expect(addresses[0]!.lat).toBeCloseTo(0.0005, 5);
    expect(addresses[0]!.lon).toBeCloseTo(0.0005, 5);
  });

  it('ignores addresses with only one of housenumber/street', () => {
    const raw = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0, tags: { 'addr:housenumber': '42' } },
        { id: 2, lat: 0, lon: 0.001, tags: { 'addr:street': 'Strandvejen' } },
      ],
      ways: [],
    });
    expect(osmToPack(raw).places).toHaveLength(0);
  });
});
