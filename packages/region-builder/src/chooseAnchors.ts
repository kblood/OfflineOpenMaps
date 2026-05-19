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
 *   - routeWaypoints: pick two well-connected nodes in opposite quadrants of
 *     the bbox so the route has to traverse a meaningful portion of the graph.
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

  // Route waypoints: nodes near the SW and NE quadrants. We don't pick the
  // extreme corners because they're often disconnected dead-ends in OSM.
  const swTarget = { lat: minLat + (maxLat - minLat) * 0.25, lon: minLon + (maxLon - minLon) * 0.25 };
  const neTarget = { lat: minLat + (maxLat - minLat) * 0.75, lon: minLon + (maxLon - minLon) * 0.75 };
  const a = nearest(candidates, swTarget.lat, swTarget.lon);
  const b = nearest(candidates, neTarget.lat, neTarget.lon);
  const routeWaypoints = [
    { lat: a.lat, lon: a.lon },
    { lat: b.lat, lon: b.lon },
  ];

  return { searchTerms, reversePoint, routeWaypoints };
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
