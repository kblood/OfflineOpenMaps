import { describe, expect, it } from 'vitest';
import { snapAddressesToBuildings } from '../src/snapAddresses.js';
import type { SyntheticData } from '../src/synthetic.js';

// Reusable empty pack scaffold — we only care about the address + building
// fields in these tests.
function pack(over: Partial<SyntheticData>): SyntheticData {
  return {
    bbox: [0, 0, 1, 1],
    nodes: [],
    edges: [],
    places: [],
    ...over,
  };
}

// A tiny square footprint centered at (lon, lat) with side ~2*halfDeg.
function squareBuilding(
  id: string,
  lon: number,
  lat: number,
  halfDeg: number,
): SyntheticData['buildings'] extends infer T
  ? T extends ReadonlyArray<infer E>
    ? E
    : never
  : never {
  return {
    id,
    ring: [
      [lon - halfDeg, lat - halfDeg],
      [lon + halfDeg, lat - halfDeg],
      [lon + halfDeg, lat + halfDeg],
      [lon - halfDeg, lat + halfDeg],
      [lon - halfDeg, lat - halfDeg],
    ],
  };
}

describe('snapAddressesToBuildings', () => {
  it('snaps a lone address inside a building to that building centroid', () => {
    const data = pack({
      places: [
        {
          id: 'a:1',
          displayName: '1 Main St',
          kind: 'address',
          lat: 10.0001,
          lon: 20.0001,
          country: 'DK',
          adminPath: null,
        },
      ],
      buildings: [squareBuilding('b:1', 20, 10, 0.0005)],
    });
    const { data: out, snapped } = snapAddressesToBuildings(data);
    expect(snapped).toBe(1);
    const p = out.places[0]!;
    // The centroid is roughly (20, 10) — vertex-average of a closed ring
    // skews very slightly toward the duplicated start vertex, hence the
    // looser tolerance.
    expect(p.lat).toBeCloseTo(10, 3);
    expect(p.lon).toBeCloseTo(20, 3);
  });

  it('refuses to collapse two distinct addresses onto the same building centroid', () => {
    // Both DAWA points land inside the same building polygon — the pre-fix
    // behaviour snapped both to its centroid (the Nørholmsvej 55/57/59 bug).
    // The fix leaves them at their original adgangspunkt coordinates instead.
    const data = pack({
      places: [
        {
          id: 'a:55',
          displayName: 'Nørholmsvej 55',
          kind: 'address',
          lat: 10.0001,
          lon: 20.0001,
          country: 'DK',
          adminPath: null,
        },
        {
          id: 'a:57',
          displayName: 'Nørholmsvej 57',
          kind: 'address',
          lat: 10.0002,
          lon: 20.0002,
          country: 'DK',
          adminPath: null,
        },
      ],
      buildings: [squareBuilding('b:shared', 20, 10, 0.0005)],
    });
    const { data: out, snapped } = snapAddressesToBuildings(data);
    expect(snapped).toBe(0);
    expect(out.places[0]!.lat).toBeCloseTo(10.0001, 6);
    expect(out.places[0]!.lon).toBeCloseTo(20.0001, 6);
    expect(out.places[1]!.lat).toBeCloseTo(10.0002, 6);
    expect(out.places[1]!.lon).toBeCloseTo(20.0002, 6);
  });

  it('still snaps each address when they land in different buildings', () => {
    const data = pack({
      places: [
        {
          id: 'a:1',
          displayName: '1 Main St',
          kind: 'address',
          lat: 10.0001,
          lon: 20.0001,
          country: 'DK',
          adminPath: null,
        },
        {
          id: 'a:2',
          displayName: '2 Main St',
          kind: 'address',
          lat: 10.001,
          lon: 20.001,
          country: 'DK',
          adminPath: null,
        },
      ],
      buildings: [
        squareBuilding('b:1', 20, 10, 0.0005),
        squareBuilding('b:2', 20.001, 10.001, 0.0005),
      ],
    });
    const { snapped } = snapAddressesToBuildings(data);
    expect(snapped).toBe(2);
  });

  it('passes non-address places through unchanged', () => {
    const data = pack({
      places: [
        {
          id: 'p:1',
          displayName: 'Faketown',
          kind: 'place',
          lat: 10,
          lon: 20,
          country: 'XX',
          adminPath: null,
        },
      ],
      buildings: [squareBuilding('b:1', 20, 10, 0.001)],
    });
    const { data: out, snapped } = snapAddressesToBuildings(data);
    expect(snapped).toBe(0);
    expect(out.places[0]!.lat).toBe(10);
    expect(out.places[0]!.lon).toBe(20);
  });
});
