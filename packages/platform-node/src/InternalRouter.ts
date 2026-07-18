import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Profile, RouteRequest, RouteResult, RouteStep, Router } from '@openmaps/core';
import { RoutingUnavailableError } from '@openmaps/core';

/**
 * Real graph-based routing over the road graph stored in geocode.sqlite.
 *
 * This is NOT v1's "math fallback." It consults a real road graph extracted
 * from OpenStreetMap during the region-build step. Dijkstra over actual road
 * segments. The router doesn't model turn restrictions or traffic, so it can
 * pick suboptimal routes, but it never fakes a result.
 *
 * Schema in the same SQLite file as the geocoder:
 *   nodes(id INTEGER PRIMARY KEY, lat REAL, lon REAL)
 *   edges(id INTEGER PRIMARY KEY, from_node, to_node, length_m REAL,
 *         max_speed_kmh REAL, allows_car, allows_bike, allows_foot,
 *         road_name TEXT, way_id INTEGER)
 *   nodes_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon)
 *
 * BRouter or Valhalla can replace this later through the Router interface.
 */
export class InternalRouter implements Router {
  private readonly db: DatabaseSync;
  private readonly edgesFromStmt: StatementSync;
  private readonly nodeByIdStmt: StatementSync;
  private readonly snapStmtByProfile: Readonly<Record<Profile, StatementSync>>;
  /**
   * How many candidate snap targets to consider per waypoint when the
   * naive nearest snap lands on a foot-only sidewalk / dead-end driveway
   * / disconnected island that has no outgoing edges for the requested
   * profile. Trying ~12 candidates handles dense urban centres (Aalborg
   * Central Station has a foot-only forecourt; the nearest car-routable
   * node is ~30 m away) without exploding worst-case work.
   */
  private readonly SNAP_CANDIDATES = 12;

  readonly supportedProfiles: readonly Profile[] = ['car', 'bike', 'foot'];

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath, { readOnly: true });
    this.db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');

    this.edgesFromStmt = this.db.prepare(`
      SELECT e.id, e.from_node, e.to_node, e.length_m, e.max_speed_kmh,
             e.allows_car, e.allows_bike, e.allows_foot, e.road_name,
             n.lat AS to_lat, n.lon AS to_lon
      FROM edges e JOIN nodes n ON n.id = e.to_node
      WHERE e.from_node = ?
    `);
    this.nodeByIdStmt = this.db.prepare('SELECT lat, lon FROM nodes WHERE id = ?');
    // Snap-candidate finders, one per profile. SQLite can't parameterize
    // column names, so we prepare three near-identical statements that
    // each filter to nodes with at least one outgoing edge allowed for
    // that profile.
    const prepareSnap = (col: 'allows_car' | 'allows_bike' | 'allows_foot'): StatementSync =>
      this.db.prepare(`
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
      throw new RoutingUnavailableError(`profile ${req.profile} not supported`, 'profile-unsupported');
    }

    // For each waypoint pre-compute the K nearest profile-routable
    // candidate snap nodes (sorted by squared-flat distance). Real OSM
    // data has lots of foot-only forecourts, parking driveways, and
    // bbox-clipped islands; the naive "absolute nearest node" picks one
    // of those and Dijkstra returns no-route. Trying multiple candidates
    // means the first viable pair wins.
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
      let chosen: { path: NonNullable<DijkstraPath>; aId: number; bId: number } | null = null;
      // Try (aCandidates[k], bCandidates[k]) in expanding diagonals so we
      // consume both arrays roughly evenly rather than exhausting all of
      // `b` against `aCandidates[0]` (which is what nested loops do).
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
    this.db.close();
  }

  /**
   * Return up to `k` candidate snap nodes, sorted by distance ascending,
   * each of which has at least one outgoing edge that allows `profile`.
   *
   * Real OSM extracts have many nodes near a coordinate that are NOT
   * usable for the requested profile — Aalborg Central Station's
   * forecourt nodes have only foot-allowed edges, so a car-routing query
   * that snaps to the absolute nearest of them lands on a dead-end
   * relative to the road graph. We filter at SQL time using `EXISTS`
   * over the edges table and grow the search radius until we have
   * enough candidates.
   */
  private nearestNodes(lat: number, lon: number, profile: Profile, k: number): number[] {
    const stmt = this.snapStmtByProfile[profile];
    const radii = [500, 1500, 5000];
    for (const r of radii) {
      const dLat = r / 111_320;
      const dLon = r / (111_320 * Math.cos((lat * Math.PI) / 180));
      const rows = stmt.all(
        lat - dLat,
        lat + dLat,
        lon - dLon,
        lon + dLon,
      ) as unknown as ReadonlyArray<{ id: number; lat: number; lon: number }>;
      if (rows.length === 0) continue;
      const scored = rows
        .map((n) => ({ id: n.id, d: squaredFlat(lat, lon, n.lat, n.lon) }))
        .sort((a, b) => a.d - b.d);
      return scored.slice(0, k).map((s) => s.id);
    }
    return [];
  }

  private dijkstra(
    fromId: number,
    toId: number,
    profile: Profile,
  ): DijkstraPath | null {
    if (fromId === toId) {
      const nodeRow = this.nodeByIdStmt.get(fromId) as unknown as { lat: number; lon: number } | undefined;
      if (!nodeRow) return null;
      return {
        geometry: [[nodeRow.lon, nodeRow.lat]],
        distanceM: 0,
        durationS: 0,
        steps: [
          { instruction: 'Start', distanceM: 0, durationS: 0, maneuver: 'depart', geometryStart: 0 },
        ],
      };
    }

    const targetRow = this.nodeByIdStmt.get(toId);
    if (!targetRow) return null;
    const targetLat = Number(targetRow['lat']);
    const targetLon = Number(targetRow['lon']);
    const dist = new Map<number, number>();
    const prev = new Map<number, { nodeId: number; edgeId: number; roadName: string | null }>();
    dist.set(fromId, 0);

    // A* retains Dijkstra's exact result while making a country-scale graph
    // practical: straight-line travel at the profile's maximum speed is an
    // admissible lower-bound on remaining travel time.
    const heap = new MinHeap<{ id: number; d: number; priority: number }>((a, b) => a.priority - b.priority);
    heap.push({ id: fromId, d: 0, priority: 0 });

    const allowsField: keyof EdgeRow =
      profile === 'car' ? 'allows_car' : profile === 'bike' ? 'allows_bike' : 'allows_foot';

    while (heap.size > 0) {
      const cur = heap.pop()!;
      if (cur.d > (dist.get(cur.id) ?? Infinity)) continue;
      if (cur.id === toId) break;
      const edges = this.edgesFromStmt.all(cur.id) as unknown as EdgeRow[];
      for (const e of edges) {
        if (e[allowsField] === 0) continue;
        const cost = edgeCost(e, profile);
        const alt = cur.d + cost;
        if (alt < (dist.get(e.to_node) ?? Infinity)) {
          dist.set(e.to_node, alt);
          prev.set(e.to_node, { nodeId: cur.id, edgeId: e.id, roadName: e.road_name });
          const node = { lat: e.to_lat, lon: e.to_lon };
          const maxSpeed = profile === 'foot' ? 5 : profile === 'bike' ? 18 : 130;
          const heuristic = node
            ? (haversineMeters(node.lat, node.lon, targetLat, targetLon) / 1000 / maxSpeed) * 3600
            : 0;
          heap.push({ id: e.to_node, d: alt, priority: alt + heuristic });
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

    const placeholders = pathNodes.map(() => '?').join(',');
    const nodeCoords = this.db
      .prepare(`SELECT id, lat, lon FROM nodes WHERE id IN (${placeholders})`)
      .all(...pathNodes) as unknown as ReadonlyArray<{ id: number; lat: number; lon: number }>;
    const byId = new Map(nodeCoords.map((n) => [n.id, n]));
    const geometry: Array<[number, number]> = pathNodes.map((id) => {
      const n = byId.get(id)!;
      return [n.lon, n.lat];
    });

    const edgePh = pathEdges.map(() => '?').join(',');
    const edgeRows =
      pathEdges.length > 0
        ? (this.db
            .prepare(
              `SELECT id, length_m, max_speed_kmh, road_name FROM edges WHERE id IN (${edgePh})`,
            )
            .all(...pathEdges.map((e) => e.edgeId)) as unknown as ReadonlyArray<{
            id: number;
            length_m: number;
            max_speed_kmh: number;
            road_name: string | null;
          }>)
        : [];
    const edgeById = new Map(edgeRows.map((e) => [e.id, e]));

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
  allows_car: 0 | 1;
  allows_bike: 0 | 1;
  allows_foot: 0 | 1;
  road_name: string | null;
  to_lat: number;
  to_lon: number;
}

function edgeCost(e: EdgeRow, profile: Profile): number {
  const cap = profile === 'foot' ? 5 : profile === 'bike' ? 18 : 130;
  const effective = Math.min(e.max_speed_kmh > 0 ? e.max_speed_kmh : cap, cap);
  return (e.length_m / 1000 / effective) * 3600;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = Math.PI / 180;
  const dLat = (lat2 - lat1) * radians;
  const dLon = (lon2 - lon1) * radians;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
