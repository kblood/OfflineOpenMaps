import type { SyntheticData } from './synthetic.js';

/**
 * Pick reasonable self-test anchors from real OSM-derived data. The synthetic
 * pack uses hand-tuned anchors ("Faketown", grid (3,3), corners) — for real
 * data we have to discover them:
 *
 *   - searchTerms: pick the place feature with the longest display name (a
 *     proxy for "specific enough to be unambiguous"), and one road name. The
 *     forward search must be able to find both.
 *   - reversePoint: pick a node that has at least 2 incident edges, near the
 *     bbox center. That ensures the reverse-geocoder finds an edge nearby.
 *   - routeWaypoints: use the ends of a real road edge near the bbox centre.
 *     This proves routing operates on the graph without making a self-test
 *     Dijkstra traverse an entire country-scale regional pack.
 */
export function chooseAnchors(data: SyntheticData): {
  searchTerms: string[];
  reversePoint: { lat: number; lon: number };
  routeWaypoints: Array<{ lat: number; lon: number }>;
} {
  if (data.nodes.length === 0) throw new Error('cannot choose anchors: no nodes');
  if (data.edges.length === 0) throw new Error('cannot choose anchors: no edges (graph is empty)');

  // Search terms: longest place name + a road name.
  const namedPlaces = [...data.places].filter((p) => p.kind === 'place' || p.kind === 'admin');
  const placePick = namedPlaces.sort((a, b) => b.displayName.length - a.displayName.length)[0]
    ?? data.places[0];
  // Most-used road name (frequency = number of edges with that name).
  const roadFreq = new Map<string, number>();
  for (const e of data.edges) {
    if (!e.roadName.startsWith('(')) {
      roadFreq.set(e.roadName, (roadFreq.get(e.roadName) ?? 0) + 1);
    }
  }
  const topRoad = [...roadFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const searchTerms: string[] = [];
  if (placePick) searchTerms.push(placePick.displayName);
  if (topRoad) searchTerms.push(topRoad);
  if (searchTerms.length === 0) searchTerms.push('road'); // last-ditch fallback

  // Degree of each node (in + out).
  const degree = new Map<number, number>();
  for (const e of data.edges) {
    degree.set(e.fromNode, (degree.get(e.fromNode) ?? 0) + 1);
    degree.set(e.toNode, (degree.get(e.toNode) ?? 0) + 1);
  }
  const wellConnected = data.nodes.filter((n) => (degree.get(n.id) ?? 0) >= 2);
  // If almost nothing is well-connected (very sparse extract), fall back to all nodes.
  const candidates = wellConnected.length >= 2 ? wellConnected : data.nodes;

  const [minLon, minLat, maxLon, maxLat] = data.bbox;
  const cLat = (minLat + maxLat) / 2;
  const cLon = (minLon + maxLon) / 2;

  // Reverse point: well-connected node closest to bbox center.
  const reverseNode = nearest(candidates, cLat, cLon);
  const reversePoint = { lat: reverseNode.lat, lon: reverseNode.lon };

  // Find a directly-connected edge near the centre, then walk its connected
  // component to a nearby-but-distinct node. A very short OSM edge can have
  // both endpoints snap to the same routing node (the browser deliberately
  // considers several nearest candidates), which would make the route look
  // empty even though the graph is sound. Keeping the walk local still makes
  // the self-test cheap on country-scale regional packs.
  const nodesById = new Map(data.nodes.map((node) => [node.id, node]));
  let routeEdge: (typeof data.edges)[number] | undefined;
  let routeEdgeDistance = Infinity;
  for (const edge of data.edges) {
    // The offline self-test routes with the car profile. A path/track can be
    // perfectly valid map data but cannot prove the car router works.
    if (!edge.allowsCar) continue;
    const from = nodesById.get(edge.fromNode);
    const to = nodesById.get(edge.toNode);
    if (!from || !to) continue;
    const midLat = (from.lat + to.lat) / 2;
    const midLon = (from.lon + to.lon) / 2;
    const distance = (midLat - cLat) ** 2 + (midLon - cLon) ** 2;
    if (distance < routeEdgeDistance) {
      routeEdge = edge;
      routeEdgeDistance = distance;
    }
  }
  if (!routeEdge) throw new Error('cannot choose route anchors: graph has no complete edges');
  const a = nodesById.get(routeEdge.fromNode)!;
  const b = findDistinctReachableNode(a, routeEdge.toNode, data.edges, nodesById);
  const routeWaypoints = [
    { lat: a.lat, lon: a.lon },
    { lat: b.lat, lon: b.lon },
  ];

  return { searchTerms, reversePoint, routeWaypoints };
}

function findDistinctReachableNode(
  start: { id: number; lat: number; lon: number },
  firstHopId: number,
  edges: SyntheticData['edges'],
  nodesById: ReadonlyMap<number, { id: number; lat: number; lon: number }>,
): { id: number; lat: number; lon: number } {
  const neighbours = new Map<number, number[]>();
  for (const edge of edges) {
    if (!edge.allowsCar) continue;
    const list = neighbours.get(edge.fromNode) ?? [];
    list.push(edge.toNode);
    neighbours.set(edge.fromNode, list);
  }

  // Around 200 m in latitude/longitude degrees. This is comfortably beyond
  // nearest-node ambiguity while remaining a short, reliable graph route.
  const minSquaredDistance = 0.000_004;
  const queue = [firstHopId];
  const visited = new Set<number>([start.id]);
  let fallback = nodesById.get(firstHopId) ?? start;

  for (let index = 0; index < queue.length && index < 1_000; index += 1) {
    const id = queue[index]!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodesById.get(id);
    if (!node) continue;
    fallback = node;
    const dLat = node.lat - start.lat;
    const dLon = node.lon - start.lon;
    if (dLat * dLat + dLon * dLon >= minSquaredDistance) return node;
    for (const neighbour of neighbours.get(id) ?? []) {
      if (!visited.has(neighbour)) queue.push(neighbour);
    }
  }

  return fallback;
}

function nearest(
  nodes: ReadonlyArray<{ id: number; lat: number; lon: number }>,
  lat: number,
  lon: number,
): { id: number; lat: number; lon: number } {
  let best = nodes[0]!;
  let bestD = Infinity;
  for (const n of nodes) {
    const dLat = n.lat - lat;
    const dLon = n.lon - lon;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}
