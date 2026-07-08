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

/**
 * Member of a relation. We only care about way members in role outer/inner
 * for multipolygon polygon assembly; node members and other roles are kept
 * for completeness but ignored downstream.
 */
export interface RawOsmRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
}

export interface RawOsmRelation {
  id: number;
  members: ReadonlyArray<RawOsmRelationMember>;
  tags: ReadonlyMap<string, string>;
}

export interface RawOsm {
  nodes: ReadonlyArray<RawOsmNode>;
  ways: ReadonlyArray<RawOsmWay>;
  /**
   * Relations are optional — older readers may omit them entirely, in which
   * case `osmToPack` simply emits no relation-derived water polygons.
   */
  relations?: ReadonlyArray<RawOsmRelation>;
}
