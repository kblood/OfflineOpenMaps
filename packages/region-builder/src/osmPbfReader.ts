import { createOSMStream } from 'osm-pbf-parser-node';
import type {
  RawOsm,
  RawOsmNode,
  RawOsmRelation,
  RawOsmRelationMember,
  RawOsmWay,
} from './osmTypes.js';

/**
 * Streaming reader for OSM PBF (Geofabrik exports use this format). Wraps
 * `osm-pbf-parser-node`, which streams a sequence of header / node / way /
 * relation objects. We materialize the same `RawOsm` shape as osmXmlReader
 * so the downstream `osmToPack → writeMbtiles/writeGeocode` pipeline is
 * format-agnostic.
 *
 * Optional `clipBbox` filtering happens at parse time: nodes outside the
 * bbox never enter the in-memory buffer at all, and ways whose nodeRefs
 * land entirely outside are dropped before we add them. That keeps the
 * memory footprint proportional to the clipped region, not the full PBF.
 *
 * Relations: kept (members + tags) for downstream multipolygon-water
 * assembly. Turn-restriction relations and other types are captured but
 * ignored by osmToPack.
 */
export interface OsmPbfReadOpts {
  /** Drop nodes outside this bbox during parse: [minLon, minLat, maxLon, maxLat]. */
  clipBbox?: [number, number, number, number];
  /**
   * Optional progress callback fired every `progressInterval` entities so the
   * CLI can show a counter for multi-minute Geofabrik runs.
   */
  onProgress?(counts: { nodes: number; ways: number }): void;
  progressInterval?: number;
}

interface ParsedNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}
interface ParsedWay {
  type: 'way';
  id: number;
  refs: number[];
  tags?: Record<string, string>;
}
interface ParsedRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
}
interface ParsedRelation {
  type: 'relation';
  id: number;
  members?: ParsedRelationMember[];
  tags?: Record<string, string>;
}
type ParsedItem = ParsedNode | ParsedWay | ParsedRelation | Record<string, unknown>;

export async function readOsmPbf(path: string, opts: OsmPbfReadOpts = {}): Promise<RawOsm> {
  const nodes: RawOsmNode[] = [];
  const ways: RawOsmWay[] = [];
  const relations: RawOsmRelation[] = [];
  const clip = opts.clipBbox;
  // The membership set is only needed to discard ways outside a clipped
  // extract. Keeping it for an un-clipped country file duplicates millions
  // of node IDs and hits V8's Set-size limit before parsing can finish.
  const keptNodeIds = clip ? new Set<number>() : null;
  const interval = opts.progressInterval ?? 100_000;

  let seen = 0;
  for await (const item of createOSMStream(path, { withTags: true }) as AsyncIterable<ParsedItem>) {
    const t = (item as { type?: string }).type;
    if (t === 'node') {
      const n = item as ParsedNode;
      if (clip && !inBbox(n.lat, n.lon, clip)) continue;
      nodes.push({
        id: n.id,
        lat: n.lat,
        lon: n.lon,
        tags: tagMap(n.tags),
      });
      keptNodeIds?.add(n.id);
      seen += 1;
      if (opts.onProgress && seen % interval === 0) {
        opts.onProgress({ nodes: nodes.length, ways: ways.length });
      }
    } else if (t === 'way') {
      const w = item as ParsedWay;
      // If we're clipping, drop ways that don't touch the kept-node set at
      // all. osmToPack's per-segment "skip refs we can't resolve" handles
      // partial overlap, but pre-filtering saves memory.
      if (clip) {
        let any = false;
        for (const ref of w.refs) {
          if (keptNodeIds?.has(ref)) {
            any = true;
            break;
          }
        }
        if (!any) continue;
      }
      ways.push({
        id: w.id,
        nodeRefs: w.refs,
        tags: tagMap(w.tags),
      });
    } else if (t === 'relation') {
      const r = item as ParsedRelation;
      // Only keep relations tagged as something we might assemble into a
      // polygon (multipolygon water and similar). Pre-filtering here keeps
      // memory bounded on country-sized PBFs where most relations are
      // turn restrictions or routes we don't care about.
      const tags = r.tags ?? {};
      if (!isInterestingRelation(tags)) continue;
      const members: RawOsmRelationMember[] = (r.members ?? []).map((m) => ({
        type: m.type,
        ref: m.ref,
        role: m.role,
      }));
      relations.push({ id: r.id, members, tags: new Map(Object.entries(tags)) });
    }
    // Header block has no `type` — also ignored.
  }
  if (opts.onProgress) {
    opts.onProgress({ nodes: nodes.length, ways: ways.length });
  }
  return { nodes, ways, relations };
}

/**
 * Cheap pre-filter for PBF relations. Without this every country-sized
 * Geofabrik extract pulls in millions of turn restrictions and routes we'd
 * just throw away. Mirrors the categories osmToPack actually consumes
 * (currently water multipolygons).
 */
function isInterestingRelation(tags: Record<string, string>): boolean {
  if (tags['type'] !== 'multipolygon') return false;
  if (tags['natural'] === 'water') return true;
  if (tags['waterway'] === 'riverbank') return true;
  if (tags['landuse'] === 'reservoir' || tags['landuse'] === 'basin') return true;
  if (tags['building']) return true;
  return false;
}

function tagMap(tags: Record<string, string> | undefined): ReadonlyMap<string, string> {
  if (!tags) return new Map();
  return new Map(Object.entries(tags));
}

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}
