import type { Profile, RouteRequest, RouteResult, RouteStep, Router } from '@openmaps/core';
import { RoutingUnavailableError } from '@openmaps/core';
import type { WebDb, Stmt } from './sqlite.js';

/**
 * Browser port of packages/platform-node/src/InternalRouter.ts. Dijkstra
 * over the road graph stored in geocode.sqlite. Algorithm + heuristics
 * (K-nearest snap, profile-masked edges) are unchanged from the node
 * version; only the SQLite handle differs.
 */
export class InternalRouter implements Router {
  private readonly db: WebDb;
  private readonly edgesFromStmt: Stmt;
  private readonly nodeByIdStmt: Stmt;
  private readonly snapStmtByProfile: Readonly<Record<Profile, Stmt>>;
  private readonly SNAP_CANDIDATES = 12;

  readonly supportedProfiles: readonly Profile[] = ['car', 'bike', 'foot'];

  constructor(db: WebDb) {
    this.db = db;
    this.edgesFromStmt = db.prepare(`
      SELECT id, from_node, to_node, length_m, max_speed_kmh,
             allows_car, allows_bike, allows_foot, road_name
      FROM edges
      WHERE from_node = ?
    `);
    this.nodeByIdStmt = db.prepare('SELECT lat, lon FROM nodes WHERE id = ?');
    const prepareSnap = (col: 'allows_car' | 'allows_bike' | 'allows_foot'): Stmt =>
      db.prepare(`
        SELECT n.id AS id, n.lat AS lat, n.lon AS lon
        FROM nodes_rtree nr JOIN nodes n ON n.id = nr.id
        WHERE nr.max_lat >= ? AND nr.min_lat <= ? AND nr.max_lon >= ? AND nr.min_lon <= ?
          AND EXISTS (SELECT 1 FROM edges e WHERE e.from_node = n.id AND e.${col} = 1)
      `);
    this.snapStmtByProfile = {
      car: prepareSnap('allows_car'),
      bike: prepareSnap('allows_bike'),
      foot: prepareSnap('allows_foot'),
    };
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
    for (const wp of req.waypoints) {
      const ids = this.nearestNodes(wp.lat, wp.lon, req.profile, this.SNAP_CANDIDATES);
      if (ids.length === 0) {
        throw new RoutingUnavailableError(
          `no road within range of waypoint ${wp.lat},${wp.lon}`,
          'no-graph',
        );
      }
      candidates.push(ids);
    }

    const allGeometry: Array<[number, number]> = [];
    const allSteps: RouteStep[] = [];
    let totalDistanceM = 0;
    let totalDurationS = 0;
    const snapped: number[] = [];

    for (let i = 0; i < candidates.length - 1; i += 1) {
      const aCandidates = i === 0 ? candidates[i]! : [snapped[i]!];
      const bCandidates = candidates[i + 1]!;
      let chosen: { path: DijkstraPath; aId: number; bId: number } | null = null;
      const tried = new Set<string>();
      for (let s = 0; s < aCandidates.length + bCandidates.length - 1 && !chosen; s += 1) {
        for (let aj = 0; aj <= s && !chosen; aj += 1) {
          const bj = s - aj;
          if (aj >= aCandidates.length || bj >= bCandidates.length) continue;
          const aId = aCandidates[aj]!;
          const bId = bCandidates[bj]!;
          const key = `${aId}->${bId}`;
          if (tried.has(key)) continue;
          tried.add(key);
          const p = this.dijkstra(aId, bId, req.profile);
          if (p) chosen = { path: p, aId, bId };
        }
      }
      if (!chosen) {
        throw new RoutingUnavailableError(
          `no path from waypoint ${i} to ${i + 1} for profile ${req.profile}`,
          'no-route',
        );
      }
      if (i === 0) snapped.push(chosen.aId);
      snapped.push(chosen.bId);
      const path = chosen.path;
      const stepGeomStart = allGeometry.length;
      const startIdx = allGeometry.length === 0 ? 0 : 1;
      for (let g = startIdx; g < path.geometry.length; g += 1) {
        allGeometry.push(path.geometry[g]!);
      }
      for (const s of path.steps) {
        allSteps.push({ ...s, geometryStart: stepGeomStart + s.geometryStart });
      }
      totalDistanceM += path.distanceM;
      totalDurationS += path.durationS;
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
      engine: 'internal-dijkstra',
    };
  }

  async close(): Promise<void> {
    // The DB is owned by the pack loader.
  }

  private nearestNodes(lat: number, lon: number, profile: Profile, k: number): number[] {
    const stmt = this.snapStmtByProfile[profile];
    const radii = [500, 1500, 5000];
    for (const r of radii) {
      const dLat = r / 111_320;
      const dLon = r / (111_320 * Math.cos((lat * Math.PI) / 180));
      const rows = stmt.all(lat - dLat, lat + dLat, lon - dLon, lon + dLon);
      if (rows.length === 0) continue;
      const scored = rows
        .map((n) => ({
          id: Number(n['id']),
          d: squaredFlat(lat, lon, Number(n['lat']), Number(n['lon'])),
        }))
        .sort((a, b) => a.d - b.d);
      return scored.slice(0, k).map((s) => s.id);
    }
    return [];
  }

  private dijkstra(fromId: number, toId: number, profile: Profile): DijkstraPath | null {
    if (fromId === toId) {
      const nodeRow = this.nodeByIdStmt.get(fromId);
      if (!nodeRow) return null;
      return {
        geometry: [[Number(nodeRow['lon']), Number(nodeRow['lat'])]],
        distanceM: 0,
        durationS: 0,
        steps: [
          { instruction: 'Start', distanceM: 0, durationS: 0, maneuver: 'depart', geometryStart: 0 },
        ],
      };
    }

    const dist = new Map<number, number>();
    const prev = new Map<number, { nodeId: number; edgeId: number; roadName: string | null }>();
    dist.set(fromId, 0);

    const heap = new MinHeap<{ id: number; d: number }>((a, b) => a.d - b.d);
    heap.push({ id: fromId, d: 0 });

    const allowsField: 'allows_car' | 'allows_bike' | 'allows_foot' =
      profile === 'car' ? 'allows_car' : profile === 'bike' ? 'allows_bike' : 'allows_foot';

    while (heap.size > 0) {
      const cur = heap.pop()!;
      if (cur.d > (dist.get(cur.id) ?? Infinity)) continue;
      if (cur.id === toId) break;
      const edges = this.edgesFromStmt.all(cur.id);
      for (const eRow of edges) {
        const allows = Number(eRow[allowsField]);
        if (allows === 0) continue;
        const e: EdgeRow = {
          id: Number(eRow['id']),
          from_node: Number(eRow['from_node']),
          to_node: Number(eRow['to_node']),
          length_m: Number(eRow['length_m']),
          max_speed_kmh: Number(eRow['max_speed_kmh']),
          road_name: eRow['road_name'] == null ? null : String(eRow['road_name']),
        };
        const cost = edgeCost(e, profile);
        const alt = cur.d + cost;
        if (alt < (dist.get(e.to_node) ?? Infinity)) {
          dist.set(e.to_node, alt);
          prev.set(e.to_node, { nodeId: cur.id, edgeId: e.id, roadName: e.road_name });
          heap.push({ id: e.to_node, d: alt });
        }
      }
    }

    if (!dist.has(toId)) return null;

    const pathNodes: number[] = [toId];
    const pathEdges: Array<{ edgeId: number; roadName: string | null }> = [];
    let cursor = toId;
    while (cursor !== fromId) {
      const p = prev.get(cursor);
      if (!p) return null;
      pathNodes.push(p.nodeId);
      pathEdges.push({ edgeId: p.edgeId, roadName: p.roadName });
      cursor = p.nodeId;
    }
    pathNodes.reverse();
    pathEdges.reverse();

    // Batch-fetch node coordinates and edge length/speed in one round-trip
    // each. We compose the IN(...) placeholders inline because sqlite-wasm
    // (like node:sqlite) doesn't support array parameters directly.
    const placeholders = pathNodes.map(() => '?').join(',');
    const nodeStmt = this.db.prepare(`SELECT id, lat, lon FROM nodes WHERE id IN (${placeholders})`);
    const nodeCoords = nodeStmt.all(...pathNodes);
    nodeStmt.finalize();
    const byId = new Map(
      nodeCoords.map((n) => [
        Number(n['id']),
        { lat: Number(n['lat']), lon: Number(n['lon']) },
      ]),
    );
    const geometry: Array<[number, number]> = pathNodes.map((id) => {
      const n = byId.get(id)!;
      return [n.lon, n.lat];
    });

    let edgeById: Map<number, { length_m: number; max_speed_kmh: number; road_name: string | null }>;
    if (pathEdges.length > 0) {
      const edgePh = pathEdges.map(() => '?').join(',');
      const edgeStmt = this.db.prepare(
        `SELECT id, length_m, max_speed_kmh, road_name FROM edges WHERE id IN (${edgePh})`,
      );
      const edgeRows = edgeStmt.all(...pathEdges.map((e) => e.edgeId));
      edgeStmt.finalize();
      edgeById = new Map(
        edgeRows.map((e) => [
          Number(e['id']),
          {
            length_m: Number(e['length_m']),
            max_speed_kmh: Number(e['max_speed_kmh']),
            road_name: e['road_name'] == null ? null : String(e['road_name']),
          },
        ]),
      );
    } else {
      edgeById = new Map();
    }

    const steps: RouteStep[] = [
      { instruction: 'Start', distanceM: 0, durationS: 0, maneuver: 'depart', geometryStart: 0 },
    ];
    let runRoad: string | null = null;
    let runDist = 0;
    let runDur = 0;
    let runStartGeom = 0;
    const speedKmh = profile === 'foot' ? 5 : profile === 'bike' ? 18 : 50;

    for (let i = 0; i < pathEdges.length; i += 1) {
      const e = edgeById.get(pathEdges[i]!.edgeId);
      if (!e) continue;
      const effectiveSpeed = Math.min(e.max_speed_kmh || speedKmh, speedKmh);
      const dur = (e.length_m / 1000 / effectiveSpeed) * 3600;
      const name = e.road_name;
      if (i === 0) {
        runRoad = name;
        runStartGeom = 0;
      } else if (name !== runRoad) {
        steps.push({
          instruction: runRoad ? `Continue on ${runRoad}` : 'Continue',
          distanceM: Math.round(runDist),
          durationS: Math.round(runDur),
          maneuver: 'straight',
          geometryStart: runStartGeom,
        });
        runRoad = name;
        runDist = 0;
        runDur = 0;
        runStartGeom = i;
      }
      runDist += e.length_m;
      runDur += dur;
    }
    if (runDist > 0) {
      steps.push({
        instruction: runRoad ? `Continue on ${runRoad}` : 'Continue',
        distanceM: Math.round(runDist),
        durationS: Math.round(runDur),
        maneuver: 'straight',
        geometryStart: runStartGeom,
      });
    }

    let distM = 0;
    let durS = 0;
    for (const pe of pathEdges) {
      const e = edgeById.get(pe.edgeId);
      if (!e) continue;
      const eff = Math.min(e.max_speed_kmh || speedKmh, speedKmh);
      distM += e.length_m;
      durS += (e.length_m / 1000 / eff) * 3600;
    }

    return { geometry, distanceM: distM, durationS: durS, steps };
  }
}

interface DijkstraPath {
  geometry: Array<[number, number]>;
  distanceM: number;
  durationS: number;
  steps: RouteStep[];
}

interface EdgeRow {
  id: number;
  from_node: number;
  to_node: number;
  length_m: number;
  max_speed_kmh: number;
  road_name: string | null;
}

function edgeCost(e: EdgeRow, profile: Profile): number {
  const cap = profile === 'foot' ? 5 : profile === 'bike' ? 18 : 130;
  const effective = Math.min(e.max_speed_kmh > 0 ? e.max_speed_kmh : cap, cap);
  return (e.length_m / 1000 / effective) * 3600;
}

function squaredFlat(la1: number, lo1: number, la2: number, lo2: number): number {
  const dx = (lo2 - lo1) * Math.cos(((la1 + la2) / 2) * (Math.PI / 180));
  const dy = la2 - la1;
  return dx * dx + dy * dy;
}

class MinHeap<T> {
  private readonly data: T[] = [];
  constructor(private readonly cmp: (a: T, b: T) => number) {}
  get size(): number {
    return this.data.length;
  }
  push(v: T): void {
    this.data.push(v);
    let i = this.data.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(this.data[i]!, this.data[p]!) < 0) {
        [this.data[i], this.data[p]] = [this.data[p]!, this.data[i]!];
        i = p;
      } else break;
    }
  }
  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0]!;
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      let i = 0;
      const n = this.data.length;
      while (true) {
        const l = i * 2 + 1;
        const r = i * 2 + 2;
        let smallest = i;
        if (l < n && this.cmp(this.data[l]!, this.data[smallest]!) < 0) smallest = l;
        if (r < n && this.cmp(this.data[r]!, this.data[smallest]!) < 0) smallest = r;
        if (smallest !== i) {
          [this.data[i], this.data[smallest]] = [this.data[smallest]!, this.data[i]!];
          i = smallest;
        } else break;
      }
    }
    return top;
  }
}
