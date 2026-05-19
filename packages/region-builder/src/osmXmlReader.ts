import { createReadStream } from 'node:fs';
import sax from 'sax';
import type { RawOsm, RawOsmNode, RawOsmWay } from './osmTypes.js';

/**
 * Streaming SAX-based parser for OSM XML (.osm and .osm.bz2-decompressed
 * files, plus Overpass API XML responses). Streaming matters because a city-
 * sized Overpass extract can easily exceed memory budgets if you DOM-parse it.
 *
 * We build the full node/way lists in memory anyway (since downstream
 * conversion needs random access into nodes), but we never allocate the
 * entire XML tree at once — just the data structures we keep.
 *
 * Unsupported by design: <relation> elements (we ignore turn restrictions and
 * multi-polygons for the v1 ingestion pass). Tags on nodes outside any kept
 * way are still preserved so they can become POI places.
 */
export async function readOsmXml(path: string): Promise<RawOsm> {
  const parser = sax.createStream(true, { trim: false, position: false });

  const nodes: RawOsmNode[] = [];
  const ways: RawOsmWay[] = [];

  let currentNode: { id: number; lat: number; lon: number; tags: Map<string, string> } | null = null;
  let currentWay: { id: number; nodeRefs: number[]; tags: Map<string, string> } | null = null;

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
    } else if (name === 'nd' && currentWay) {
      const ref = Number(attrs.ref);
      if (Number.isFinite(ref)) currentWay.nodeRefs.push(ref);
    } else if (name === 'tag') {
      const k = attrs.k;
      const v = attrs.v;
      if (typeof k === 'string' && typeof v === 'string') {
        if (currentNode) currentNode.tags.set(k, v);
        else if (currentWay) currentWay.tags.set(k, v);
      }
    }
    // <relation> and its children are silently ignored — see header comment.
  });

  parser.on('closetag', (name) => {
    if (name === 'node' && currentNode) {
      nodes.push(currentNode);
      currentNode = null;
    } else if (name === 'way' && currentWay) {
      ways.push(currentWay);
      currentWay = null;
    }
  });

  await new Promise<void>((resolve, reject) => {
    parser.on('error', reject);
    parser.on('end', () => resolve());
    createReadStream(path).on('error', reject).pipe(parser);
  });

  return { nodes, ways };
}
