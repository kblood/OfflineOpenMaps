import type { Profile, RouteRequest, RouteResult, RouteStep, Router } from '@openmaps/core';
import { RoutingUnavailableError } from '@openmaps/core';
import type { Stmt, WebDb } from './sqlite.js';

export interface WebRoutingGraphSource {
  readonly id: string;
  readonly db: WebDb;
  readonly bbox: readonly [number, number, number, number];
}

interface GraphHandle {
  readonly source: WebRoutingGraphSource;
  readonly edgesFrom: Stmt;
  readonly nodeById: Stmt;
  readonly snapByProfile: Readonly<Record<Profile, Stmt>>;
}

/** A* over independently stored regional graphs joined by global OSM node ids. */
export class CompositeRouter implements Router {
  private readonly graphs: GraphHandle[];
  private readonly nodeCoords = new Map<number, { lat: number; lon: number }>();
  private readonly SNAP_CANDIDATES = 12;

  readonly supportedProfiles: readonly Profile[] = ['car', 'bike', 'foot'];

  constructor(sources: readonly WebRoutingGraphSource[]) {
    if (sources.length === 0) throw new Error('CompositeRouter needs at least one routing graph');
    this.graphs = sources.map((source) => openGraph(source));
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    if (req.waypoints.length < 2) {
      throw new RoutingUnavailableError('need at least 2 waypoints', 'no-route');
    }
    if (!this.supportedProfiles.includes(req.profile)) {
      throw new RoutingUnavailableError(`profile ${req.profile} not supported`, 'profile-unsupported');
    }

    const candidates: number[][] = [];
    for (const waypoint of req.waypoints) {
      const ids = this.nearestNodes(waypoint.lat, waypoint.lon, req.profile, this.SNAP_CANDIDATES);
      if (ids.length === 0) {
        throw new RoutingUnavailableError(
          `no installed road graph near waypoint ${waypoint.lat},${waypoint.lon}`,
          'no-graph',
        );
      }
      candidates.push(ids);
    }

    const geometry: Array<[number, number]> = [];
    const steps: RouteStep[] = [];
    const snapped: number[] = [];
    let distanceM = 0;
    let durationS = 0;

    for (let leg = 0; leg < candidates.length - 1; leg += 1) {
      const fromCandidates = leg === 0 ? candidates[leg]! : [snapped[leg]!];
      const toCandidates = candidates[leg + 1]!;
      let chosen: { path: GraphPath; fromId: number; toId: number } | null = null;

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
          `no connected path through the installed regions from waypoint ${leg} to ${leg + 1}`,
          'no-route',
        );
      }

      if (leg === 0) snapped.push(chosen.fromId);
      snapped.push(chosen.toId);
      const stepOffset = geometry.length;
      const firstPoint = geometry.length === 0 ? 0 : 1;
      for (let index = firstPoint; index < chosen.path.geometry.length; index += 1) {
        geometry.push(chosen.path.geometry[index]!);
      }
      for (const step of chosen.path.steps) {
        steps.push({ ...step, geometryStart: stepOffset + step.geometryStart });
      }
      distanceM += chosen.path.distanceM;
      durationS += chosen.path.durationS;
    }

    if (geometry.length > 0) {
      steps.push({
        instruction: 'Arrive at destination',
        distanceM: 0,
        durationS: 0,
        maneuver: 'arrive',
        geometryStart: geometry.length - 1,
      });
    }
    return { geometry, distanceM, durationS, steps, engine: 'web-composite-a-star' };
  }

  async close(): Promise<void> {
    this.nodeCoords.clear();
  }

  private nearestNodes(lat: number, lon: number, profile: Profile, limit: number): number[] {
    const found = new Map<number, number>();
    for (const radius of [500, 1500, 5000]) {
      const dLat = radius / 111_320;
      const dLon = radius / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
      for (const graph of this.graphs) {
        if (!bboxIntersects(graph.source.bbox, lon - dLon, lat - dLat, lon + dLon, lat + dLat)) continue;
        for (const row of graph.snapByProfile[profile].all(lat - dLat, lat + dLat, lon - dLon, lon + dLon)) {
          const id = Number(row['id']);
          const nodeLat = Number(row['lat']);
          const nodeLon = Number(row['lon']);
          this.nodeCoords.set(id, { lat: nodeLat, lon: nodeLon });
          const distance = squaredFlat(lat, lon, nodeLat, nodeLon);
          const old = found.get(id);
          if (old === undefined || distance < old) found.set(id, distance);
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

  private aStar(fromId: number, toId: number, profile: Profile): GraphPath | null {
    const from = this.findNode(fromId);
    const target = this.findNode(toId);
    if (!from || !target) return null;
    if (fromId === toId) {
      return {
        geometry: [[from.lon, from.lat]],
        distanceM: 0,
        durationS: 0,
        steps: [{ instruction: 'Start', distanceM: 0, durationS: 0, maneuver: 'depart', geometryStart: 0 }],
      };
    }

    const distances = new Map<number, number>([[fromId, 0]]);
    const previous = new Map<number, { nodeId: number; edge: EdgeRow }>();
    const heap = new MinHeap<{ id: number; cost: number; priority: number }>((a, b) => a.priority - b.priority);
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

    const nodeIds: number[] = [toId];
    const edges: EdgeRow[] = [];
    let cursor = toId;
    while (cursor !== fromId) {
      const item = previous.get(cursor);
      if (!item) return null;
      nodeIds.push(item.nodeId);
      edges.push(item.edge);
      cursor = item.nodeId;
    }
    nodeIds.reverse();
    edges.reverse();

    const geometry: Array<[number, number]> = [];
    for (const nodeId of nodeIds) {
      const node = this.findNode(nodeId);
      if (!node) return null;
      geometry.push([node.lon, node.lat]);
    }
    let distanceM = 0;
    let durationS = 0;
    for (const edge of edges) {
      distanceM += edge.length_m;
      durationS += edgeCost(edge, profile);
    }
    return { geometry, distanceM, durationS, steps: buildSteps(edges, profile) };
  }

  private findNode(id: number): { lat: number; lon: number } | null {
    const cached = this.nodeCoords.get(id);
    if (cached) return cached;
    for (const graph of this.graphs) {
      const row = graph.nodeById.get(id);
      if (!row) continue;
      const node = { lat: Number(row['lat']), lon: Number(row['lon']) };
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
      if (!bboxContains(graph.source.bbox, node.lon, node.lat)) continue;
      for (const row of graph.edgesFrom.all(nodeId)) {
        const edge: EdgeRow = {
          from_node: Number(row['from_node']),
          to_node: Number(row['to_node']),
          length_m: Number(row['length_m']),
          max_speed_kmh: Number(row['max_speed_kmh']),
          allows_car: Number(row['allows_car']),
          allows_bike: Number(row['allows_bike']),
          allows_foot: Number(row['allows_foot']),
          road_name: row['road_name'] == null ? null : String(row['road_name']),
          to_lat: Number(row['to_lat']),
          to_lon: Number(row['to_lon']),
        };
        const key = [edge.from_node, edge.to_node, edge.allows_car, edge.allows_bike,
          edge.allows_foot, edge.road_name ?? '', Math.round(edge.length_m * 100),
          Math.round(edge.max_speed_kmh * 100)].join('|');
        if (!unique.has(key)) unique.set(key, edge);
      }
    }
    return [...unique.values()];
  }
}

function openGraph(source: WebRoutingGraphSource): GraphHandle {
  const prepareSnap = (column: 'allows_car' | 'allows_bike' | 'allows_foot'): Stmt => source.db.prepare(`
    SELECT n.id AS id, n.lat AS lat, n.lon AS lon
    FROM nodes_rtree nr JOIN nodes n ON n.id = nr.id
    WHERE nr.max_lat >= ? AND nr.min_lat <= ? AND nr.max_lon >= ? AND nr.min_lon <= ?
      AND EXISTS (SELECT 1 FROM edges e WHERE e.from_node = n.id AND e.${column} = 1)
  `);
  return {
    source,
    edgesFrom: source.db.prepare(`
      SELECT e.from_node, e.to_node, e.length_m, e.max_speed_kmh,
             e.allows_car, e.allows_bike, e.allows_foot, e.road_name,
             n.lat AS to_lat, n.lon AS to_lon
      FROM edges e JOIN nodes n ON n.id = e.to_node
      WHERE e.from_node = ?
    `),
    nodeById: source.db.prepare('SELECT lat, lon FROM nodes WHERE id = ?'),
    snapByProfile: {
      car: prepareSnap('allows_car'),
      bike: prepareSnap('allows_bike'),
      foot: prepareSnap('allows_foot'),
    },
  };
}

function buildSteps(edges: readonly EdgeRow[], profile: Profile): RouteStep[] {
  const steps: RouteStep[] = [
    { instruction: 'Start', distanceM: 0, durationS: 0, maneuver: 'depart', geometryStart: 0 },
  ];
  let road: string | null = null;
  let distanceM = 0;
  let durationS = 0;
  let geometryStart = 0;
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]!;
    if (index === 0) road = edge.road_name;
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
      geometryStart = index;
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

function edgeAllows(edge: EdgeRow, profile: Profile): boolean {
  return profile === 'car' ? edge.allows_car !== 0 : profile === 'bike' ? edge.allows_bike !== 0 : edge.allows_foot !== 0;
}

function edgeCost(edge: EdgeRow, profile: Profile): number {
  const cap = profile === 'foot' ? 5 : profile === 'bike' ? 18 : 130;
  const speed = Math.min(edge.max_speed_kmh > 0 ? edge.max_speed_kmh : cap, cap);
  return (edge.length_m / 1000 / speed) * 3600;
}

function bboxContains(bbox: readonly [number, number, number, number], lon: number, lat: number): boolean {
  const epsilon = 1e-7;
  return lon >= bbox[0] - epsilon && lon <= bbox[2] + epsilon
    && lat >= bbox[1] - epsilon && lat <= bbox[3] + epsilon;
}

function bboxIntersects(bbox: readonly [number, number, number, number], minLon: number, minLat: number, maxLon: number, maxLat: number): boolean {
  return bbox[0] <= maxLon && bbox[2] >= minLon && bbox[1] <= maxLat && bbox[3] >= minLat;
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

interface GraphPath { geometry: Array<[number, number]>; distanceM: number; durationS: number; steps: RouteStep[] }
interface EdgeRow {
  from_node: number; to_node: number; length_m: number; max_speed_kmh: number;
  allows_car: number; allows_bike: number; allows_foot: number; road_name: string | null;
  to_lat: number; to_lon: number;
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
