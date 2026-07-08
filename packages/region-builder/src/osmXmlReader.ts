import { createReadStream } from 'node:fs';
import sax from 'sax';
import type {
  RawOsm,
  RawOsmNode,
  RawOsmRelation,
  RawOsmRelationMember,
  RawOsmWay,
} from './osmTypes.js';

/**
 * Streaming SAX-based parser for OSM XML (.osm and .osm.bz2-decompressed
 * files, plus Overpass API XML responses). Streaming matters because a city-
 * sized Overpass extract can easily exceed memory budgets if you DOM-parse it.
 *
 * We build the full node/way/relation lists in memory anyway (since
 * downstream conversion needs random access into nodes and member ways),
 * but we never allocate the entire XML tree at once — just the data
 * structures we keep.
 *
 * Relations: kept so osmToPack can assemble multipolygon water polygons
 * (the Limfjord and similar fjords/seas in OSM are tagged as `type=
 * multipolygon natural=water` relations, not closed-ring ways). Turn
 * restrictions and other relation types are also captured but ignored
 * downstream. Node members on relations are recorded but unused for now.
 */
export async function readOsmXml(path: string): Promise<RawOsm> {
  const parser = sax.createStream(true, { trim: false, position: false });

  const nodes: RawOsmNode[] = [];
  const ways: RawOsmWay[] = [];
  const relations: RawOsmRelation[] = [];

  let currentNode: { id: number; lat: number; lon: number; tags: Map<string, string> } | null = null;
  let currentWay: { id: number; nodeRefs: number[]; tags: Map<string, string> } | null = null;
  let currentRelation: {
    id: number;
    members: RawOsmRelationMember[];
    tags: Map<string, string>;
  } | null = null;

  parser.on('opentag', (tag) => {
    const name = tag.name;
    const attrs = tag.attributes as Record<string, string>;

    if (name === 'node') {
      const id = Number(attrs.id);
      const lat = Number(attrs.lat);
      const lon = Number(attrs.lon);
      if (Number.isFinite(id) && Number.isFinite(lat) && Number.isFinite(lon)) {
        currentNode = { id, lat, lon, tags: new Map() };
      }
    } else if (name === 'way') {
      const id = Number(attrs.id);
      if (Number.isFinite(id)) {
        currentWay = { id, nodeRefs: [], tags: new Map() };
      }
    } else if (name === 'relation') {
      const id = Number(attrs.id);
      if (Number.isFinite(id)) {
        currentRelation = { id, members: [], tags: new Map() };
      }
    } else if (name === 'nd' && currentWay) {
      const ref = Number(attrs.ref);
      if (Number.isFinite(ref)) currentWay.nodeRefs.push(ref);
    } else if (name === 'member' && currentRelation) {
      const type = attrs.type;
      const ref = Number(attrs.ref);
      const role = typeof attrs.role === 'string' ? attrs.role : '';
      if ((type === 'node' || type === 'way' || type === 'relation') && Number.isFinite(ref)) {
        currentRelation.members.push({ type, ref, role });
      }
    } else if (name === 'tag') {
      const k = attrs.k;
      const v = attrs.v;
      if (typeof k === 'string' && typeof v === 'string') {
        if (currentNode) currentNode.tags.set(k, v);
        else if (currentWay) currentWay.tags.set(k, v);
        else if (currentRelation) currentRelation.tags.set(k, v);
      }
    }
  });

  parser.on('closetag', (name) => {
    if (name === 'node' && currentNode) {
      nodes.push(currentNode);
      currentNode = null;
    } else if (name === 'way' && currentWay) {
      ways.push(currentWay);
      currentWay = null;
    } else if (name === 'relation' && currentRelation) {
      relations.push(currentRelation);
      currentRelation = null;
    }
  });

  await new Promise<void>((resolve, reject) => {
    parser.on('error', reject);
    parser.on('end', () => resolve());
    createReadStream(path).on('error', reject).pipe(parser);
  });

  return { nodes, ways, relations };
}
