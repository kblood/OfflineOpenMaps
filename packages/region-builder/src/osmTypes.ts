// Raw OSM data, as it comes out of a reader (XML, PBF, Overpass, etc.).
// `osmToPack.ts` turns RawOsm into the SyntheticData shape that the writers
// know how to consume.

export interface RawOsmNode {
  id: number;
  lat: number;
  lon: number;
  tags: ReadonlyMap<string, string>;
}

export interface RawOsmWay {
  id: number;
  nodeRefs: ReadonlyArray<number>;
  tags: ReadonlyMap<string, string>;
}

export interface RawOsm {
  nodes: ReadonlyArray<RawOsmNode>;
  ways: ReadonlyArray<RawOsmWay>;
}
