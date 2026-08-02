import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Profile, RouteRequest, RouteResult, RouteStep, Router } from '@openmaps/core';
import { RoutingUnavailableError } from '@openmaps/core';

export interface RoutingGraphSource {
  readonly id: string;
  readonly filePath: string;
  readonly bbox: readonly [number, number, number, number];
}

interface GraphHandle {
  readonly source: RoutingGraphSource;
  readonly db: DatabaseSync;
  readonly edgesFrom: StatementSync;
  readonly nodeById: StatementSync;
  readonly snapByProfile: Readonly<Record<Profile, StatementSync>>;
}

/**
 * A* over several regional SQLite graphs as one logical graph.
 *
 * Regional builders preserve OSM node ids. A node present in two overlapping
 * packs is therefore a real graph junction, not a guessed geographic join.
 * Edge row ids are only local to a database and are deliberately never used
 * as cross-pack identities here.
 */
export class CompositeRouter implements Router {
  private readonly graphs: GraphHandle[];
  private readonly nodeCoords = new Map<number, { lat: number; lon: number }>();
  private readonly SNAP_CANDIDATES = 12;

  readonly supportedProfiles: readonly Profile[] = ['car', 'bike', 'foot'];

  constructor(sources: readonly RoutingGraphSource[]) {
    if (sources.length === 0) throw new Error('CompositeRouter needs at least one routing graph');

    const opened: GraphHandle[] = [];
    try {
      for (const source of sources) opened.push(openGraph(source));
      this.graphs = opened;
    } catch (error) {
      for (const graph of opened) graph.db.close();
      throw error;
    }
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    if (req.waypoints.length < 2) {
      throw new RoutingUnavailableError('need at least 2 waypoints', 'no-route');
    }
    if (!this.supportedProfiles.includes(req.profile)) {
      throw new RoutingUnavailableError(
        `profile ${req.profile} not supported`,
        'profile-unsupported',
      );
    }

    const candidates: number[][] = [];
    for (const waypoint of req.waypoints) {
      const ids = this.nearestNodes(
        waypoint.lat,
        waypoint.lon,
        req.profile,
        this.SNAP_CANDIDATES,
      );
      if (ids.length === 0) {
        throw new RoutingUnavailableError(
          `no installed road graph near waypoint ${waypoint.lat},${waypoint.lon}`,
          'no-graph',
        );
      }
      candidates.push(ids);
    }

    const allGeometry: Array<[number, number]> = [];
    const allSteps: RouteStep[] = [];
    const snapped: number[] = [];
    let totalDistanceM = 0;
    let totalDurationS = 0;

    for (let i = 0; i < candidates.length - 1; i += 1) {
      const fromCandidates = i === 0 ? candidates[i]! : [snapped[i]!];
      const toCandidates = candidates[i + 1]!;
      let chosen: { path: DijkstraPath; fromId: number; toId: number } | null = null;

      for (let diagonal = 0;
        diagonal < fromCandidates.length + toCandidates.length - 1 && !chosen;
        diagonal += 1) {
        for (let fromIndex = 0; fromIndex <= diagonal && !chosen; fromIndex += 1) {
          const toIndex = diagonal - fromIndex;
          if (fromIndex >= fromCandidates.length || toIndex >= toCandidates.length) continue;
          const fromId = fromCandidates[fromIndex]!;
          const toId = toCandidates[toIndex]!;
          const path = this.aStar(fromId, toId, req.profile);
          if (path) chosen = { path, fromId, toId };
        }
      }

      if (!chosen) {
        throw new RoutingUnavailableError(
          `no connected path through the installed regions from waypoint ${i} to ${i + 1}`,
          'no-route',
        );
      }

      if (i === 0) snapped.push(chosen.fromId);
      snapped.push(chosen.toId);
      const geometryStart = allGeometry.length;
      const firstPoint = allGeometry.length === 0 ? 0 : 1;
      for (let g = firstPoint; g < chosen.path.geometry.length; g += 1) {
        allGeometry.push(chosen.path.geometry[g]!);
      }
      for (const step of chosen.path.steps) {
        allSteps.push({ ...step, geometryStart: geometryStart + step.geometryStart });
      }
      totalDistanceM += chosen.path.distanceM;
      totalDurationS += chosen.path.durationS;
    }

    if (allGeometry.length > 0) {
      allSteps.push({
        instruction: 'Arrive at destination',
        distanceM: 0,
        durationS: 0,
        maneuver: 'arrive',
        geometryStart: allGeometry.length - 1,
      });
    }

    return {
      geometry: allGeometry,
      distanceM: totalDistanceM,
      durationS: totalDurationS,
      steps: allSteps,
      engine: 'internal-composite-a-star',
    };
  }

  async close(): Promise<void> {
    for (const graph of this.graphs) graph.db.close();
    this.nodeCoords.clear();
  }

  private nearestNodes(lat: number, lon: number, profile: Profile, limit: number): number[] {
    const found = new Map<number, number>();
    const radii = [500, 1500, 5000];

    for (const radius of radii) {
      const dLat = radius / 111_320;
      const dLon = radius / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
      for (const graph of this.graphs) {
        if (!bboxIntersects(graph.source.bbox, lon - dLon, lat - dLat, lon + dLon, lat + dLat)) {
          continue;
        }
        const rows = graph.snapByProfile[profile].all(
          lat - dLat,
          lat + dLat,
          lon - dLon,
          lon + dLon,
        ) as unknown as ReadonlyArray<{ id: number; lat: number; lon: number }>;
        for (const node of rows) {
          this.nodeCoords.set(node.id, { lat: node.lat, lon: node.lon });
          const distance = squaredFlat(lat, lon, node.lat, node.lon);
          const previous = found.get(node.id);
          if (previous === undefined || distance < previous) found.set(node.id, distance);
        }
      }
      if (found.size > 0) {
        return [...found.entries()]
          .sort((a, b) => a[1] - b[1])
          .slice(0, limit)
          .map(([id]) => id);
      }
    }
    return [];
  }

  private aStar(fromId: number, toId: number, profile: Profile): DijkstraPath | null {
    const from = this.findNode(fromId);
    const target = this.findNode(toId);
    if (!from || !target) return null;
    if (fromId === toId) {
      return {
        geometry: [[from.lon, from.lat]],
        distanceM: 0,
        durationS: 0,
        steps: [
          { instruction: 'Start', distanceM: 0, durationS: 0, maneuver: 'depart', geometryStart: 0 },
        ],
      };
    }

    const distances = new Map<number, number>([[fromId, 0]]);
    const previous = new Map<number, { nodeId: number; edge: EdgeRow }>();
    const heap = new MinHeap<{ id: number; cost: number; priority: number }>(
      (a, b) => a.priority - b.priority,
    );
    heap.push({ id: fromId, cost: 0, priority: 0 });
    const maxSpeed = profile === 'foot' ? 5 : profile === 'bike' ? 18 : 130;

    while (heap.size > 0) {
      const current = heap.pop()!;
      if (current.cost > (distances.get(current.id) ?? Infinity)) continue;
      if (current.id === toId) break;

      for (const edge of this.edgesFrom(current.id)) {
        if (!edgeAllows(edge, profile)) continue;
        const alternative = current.cost + edgeCost(edge, profile);
        if (alternative >= (distances.get(edge.to_node) ?? Infinity)) continue;

        distances.set(edge.to_node, alternative);
        previous.set(edge.to_node, { nodeId: current.id, edge });
        this.nodeCoords.set(edge.to_node, { lat: edge.to_lat, lon: edge.to_lon });
        const heuristic =
          (haversineMeters(edge.to_lat, edge.to_lon, target.lat, target.lon) / 1000 / maxSpeed) * 3600;
        heap.push({ id: edge.to_node, cost: alternative, priority: alternative + heuristic });
      }
    }

    if (!distances.has(toId)) return null;

    const pathNodes: number[] = [toId];
    const pathEdges: EdgeRow[] = [];
    let cursor = toId;
    while (cursor !== fromId) {
      const item = previous.get(cursor);
      if (!item) return null;
      pathNodes.push(item.nodeId);
      pathEdges.push(item.edge);
      cursor = item.nodeId;
    }
    pathNodes.reverse();
    pathEdges.reverse();

    const geometry: Array<[number, number]> = [];
    for (const nodeId of pathNodes) {
      const node = this.findNode(nodeId);
      if (!node) return null;
      geometry.push([node.lon, node.lat]);
    }

    const steps = buildSteps(pathEdges, profile);
    let distanceM = 0;
    let durationS = 0;
    for (const edge of pathEdges) {
      distanceM += edge.length_m;
      durationS += edgeCost(edge, profile);
    }
    return { geometry, distanceM, durationS, steps };
  }

  private findNode(id: number): { lat: number; lon: number } | null {
    const cached = this.nodeCoords.get(id);
    if (cached) return cached;
    for (const graph of this.graphs) {
      const row = graph.nodeById.get(id) as unknown as { lat: number; lon: number } | undefined;
      if (!row) continue;
      const node = { lat: Number(row.lat), lon: Number(row.lon) };
      this.nodeCoords.set(id, node);
      return node;
    }
    return null;
  }

  private edgesFrom(nodeId: number): EdgeRow[] {
    const node = this.findNode(nodeId);
    if (!node) return [];
    const unique = new Map<string, EdgeRow>();

    for (const graph of this.graphs) {
      // The manifest bbox is a cheap routing index: only databases whose
      // coverage contains this node can contribute its outgoing edges.
      if (!bboxContains(graph.source.bbox, node.lon, node.lat)) continue;
      const rows = graph.edgesFrom.all(nodeId) as unknown as EdgeRow[];
      for (const edge of rows) {
        const key = [
          edge.from_node,
          edge.to_node,
          edge.allows_car,
          edge.allows_bike,
          edge.allows_foot,
          edge.road_name ?? '',
          Math.round(edge.length_m * 100),
          Math.round(edge.max_speed_kmh * 100),
        ].join('|');
        if (!unique.has(key)) unique.set(key, edge);
      }
    }
    return [...unique.values()];
  }
}

function openGraph(source: RoutingGraphSource): GraphHandle {
  const db = new DatabaseSync(source.filePath, { readOnly: true });
  try {
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    const prepareSnap = (column: 'allows_car' | 'allows_bike' | 'allows_foot'): StatementSync =>
      db.prepare(`
        SELECT n.id AS id, n.lat AS lat, n.lon AS lon
        FROM nodes_rtree nr JOIN nodes n ON n.id = nr.id
        WHERE nr.max_lat >= ? AND nr.min_lat <= ? AND nr.max_lon >= ? AND nr.min_lon <= ?
          AND EXISTS (SELECT 1 FROM edges e WHERE e.from_node = n.id AND e.${column} = 1)
      `);
    return {
      source,
      db,
      edgesFrom: db.prepare(`
        SELECT e.from_node, e.to_node, e.length_m, e.max_speed_kmh,
               e.allows_car, e.allows_bike, e.allows_foot, e.road_name,
               n.lat AS to_lat, n.lon AS to_lon
        FROM edges e JOIN nodes n ON n.id = e.to_node
        WHERE e.from_node = ?
      `),
      nodeById: db.prepare('SELECT lat, lon FROM nodes WHERE id = ?'),
      snapByProfile: {
        car: prepareSnap('allows_car'),
        bike: prepareSnap('allows_bike'),
        foot: prepareSnap('allows_foot'),
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function bboxContains(bbox: readonly [number, number, number, number], lon: number, lat: number): boolean {
  const epsilon = 1e-7;
  return lon >= bbox[0] - epsilon && lon <= bbox[2] + epsilon
    && lat >= bbox[1] - epsilon && lat <= bbox[3] + epsilon;
}

function bboxIntersects(
  bbox: readonly [number, number, number, number],
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): boolean {
  return bbox[0] <= maxLon && bbox[2] >= minLon && bbox[1] <= maxLat && bbox[3] >= minLat;
}

function edgeAllows(edge: EdgeRow, profile: Profile): boolean {
  return profile === 'car'
    ? edge.allows_car !== 0
    : profile === 'bike'
      ? edge.allows_bike !== 0
      : edge.allows_foot !== 0;
}

function edgeCost(edge: EdgeRow, profile: Profile): number {
  const cap = profile === 'foot' ? 5 : profile === 'bike' ? 18 : 130;
  const speed = Math.min(edge.max_speed_kmh > 0 ? edge.max_speed_kmh : cap, cap);
  return (edge.length_m / 1000 / speed) * 3600;
}

function buildSteps(edges: readonly EdgeRow[], profile: Profile): RouteStep[] {
  const steps: RouteStep[] = [
    { instruction: 'Start', distanceM: 0, durationS: 0, maneuver: 'depart', geometryStart: 0 },
  ];
  let road: string | null = null;
  let distanceM = 0;
  let durationS = 0;
  let geometryStart = 0;

  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i]!;
    if (i === 0) road = edge.road_name;
    else if (edge.road_name !== road) {
      steps.push({
        instruction: road ? `Continue on ${road}` : 'Continue',
        distanceM: Math.round(distanceM),
        durationS: Math.round(durationS),
        maneuver: 'straight',
        geometryStart,
      });
      road = edge.road_name;
      distanceM = 0;
      durationS = 0;
      geometryStart = i;
    }
    distanceM += edge.length_m;
    durationS += edgeCost(edge, profile);
  }
  if (distanceM > 0) {
    steps.push({
      instruction: road ? `Continue on ${road}` : 'Continue',
      distanceM: Math.round(distanceM),
      durationS: Math.round(durationS),
      maneuver: 'straight',
      geometryStart,
    });
  }
  return steps;
}

interface DijkstraPath {
  geometry: Array<[number, number]>;
  distanceM: number;
  durationS: number;
  steps: RouteStep[];
}

interface EdgeRow {
  from_node: number;
  to_node: number;
  length_m: number;
  max_speed_kmh: number;
  allows_car: 0 | 1;
  allows_bike: 0 | 1;
  allows_foot: 0 | 1;
  road_name: string | null;
  to_lat: number;
  to_lon: number;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = Math.PI / 180;
  const dLat = (lat2 - lat1) * radians;
  const dLon = (lon2 - lon1) * radians;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function squaredFlat(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dx = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const dy = lat2 - lat1;
  return dx * dx + dy * dy;
}

class MinHeap<T> {
  private readonly data: T[] = [];
  constructor(private readonly compare: (a: T, b: T) => number) {}
  get size(): number { return this.data.length; }
  push(value: T): void {
    this.data.push(value);
    let index = this.data.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(this.data[index]!, this.data[parent]!) >= 0) break;
      [this.data[index], this.data[parent]] = [this.data[parent]!, this.data[index]!];
      index = parent;
    }
  }
  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const first = this.data[0]!;
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.data.length && this.compare(this.data[left]!, this.data[smallest]!) < 0) smallest = left;
        if (right < this.data.length && this.compare(this.data[right]!, this.data[smallest]!) < 0) smallest = right;
        if (smallest === index) break;
        [this.data[index], this.data[smallest]] = [this.data[smallest]!, this.data[index]!];
        index = smallest;
      }
    }
    return first;
  }
}
